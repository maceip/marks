//! One live in-memory ESBT room per open document, owned by one task. The
//! room consumes only validated `RoomActor`s from the Marks auth boundary;
//! ESBT receives site IDs and bytes, never identity.

mod task;
pub mod ws;

use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::store;
use marks_auth::{DocumentId, RoomActor};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::task::JoinHandle;

/// Marks room frame tags (`client/src/collab/protocol.ts`).
pub const MSG_UPDATE: u8 = 0x01;
pub const MSG_EPHEMERAL: u8 = 0x02;
pub const MSG_SERVER_VV: u8 = 0x03;
pub const MSG_SNAPSHOT: u8 = 0x04;
pub const MSG_SYNCED: u8 = 0x05;

/// Close codes. `4404` is the one the browser treats as "document deleted".
pub const CLOSE_INVALID_PAYLOAD: u16 = 4400;
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
pub const CLOSE_FORBIDDEN_WRITE: u16 = 4403;
pub const CLOSE_DOCUMENT_DELETED: u16 = 4404;
pub const CLOSE_INTERNAL: u16 = 1011;

pub fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(tag);
    out.extend_from_slice(payload);
    out
}

#[derive(Debug)]
pub enum OutMsg {
    Frame(Vec<u8>),
    Close(u16),
}

#[derive(Clone, Debug)]
pub enum Control {
    Deleted { document_id: String },
    EpochChanged { document_id: String, epoch: u64 },
    SessionRevoked { session_id: String },
    DeviceRevoked { device_id: String },
}

#[derive(Debug)]
pub struct RoomRead {
    pub text: String,
    pub full_snapshot: Option<Vec<u8>>,
    pub compact_snapshot: Option<Vec<u8>>,
    pub connections: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinRefusal {
    Gone,
    Stale,
    Internal,
}

pub enum RoomMsg {
    Join {
        actor: RoomActor,
        client_version: Option<esbt::clock::Version>,
        out: mpsc::Sender<OutMsg>,
        resp: oneshot::Sender<Result<u64, JoinRefusal>>,
    },
    Frame {
        conn: u64,
        data: Vec<u8>,
    },
    Leave {
        conn: u64,
    },
    Control(Control),
    Read {
        resp: oneshot::Sender<RoomRead>,
    },
    Shutdown {
        resp: oneshot::Sender<()>,
    },
}

struct RoomEntry {
    tx: mpsc::Sender<RoomMsg>,
    handle: JoinHandle<()>,
}

/// Owner map of resident rooms. There is exactly one live replica per open
/// document in this process; rooms rehydrate from the journal on demand.
pub struct Rooms {
    db: Arc<Db>,
    config: Arc<Config>,
    limits: esbt::ResourceLimits,
    map: Mutex<HashMap<String, RoomEntry>>,
}

pub struct JoinedRoom {
    pub conn: u64,
    pub tx: mpsc::Sender<RoomMsg>,
}

impl Rooms {
    pub fn new(db: Arc<Db>, config: Arc<Config>, limits: esbt::ResourceLimits) -> Self {
        Self {
            db,
            config,
            limits,
            map: Mutex::new(HashMap::new()),
        }
    }

    async fn entry_tx(&self, document_id: &DocumentId) -> ApiResult<mpsc::Sender<RoomMsg>> {
        let mut map = self.map.lock().await;
        if let Some(entry) = map.get(document_id.as_str()) {
            if !entry.tx.is_closed() {
                return Ok(entry.tx.clone());
            }
            map.remove(document_id.as_str());
        }
        // Never create rooms for unknown or deleted documents.
        let live = self.db.read(|conn| {
            Ok(store::load_document(conn, document_id)?
                .is_some_and(|row| row.record.deleted_at_ms.is_none()))
        })?;
        if !live {
            return Err(ApiError::not_found());
        }
        let (tx, rx) = mpsc::channel(1024);
        let handle = tokio::spawn(task::run(
            document_id.clone(),
            self.db.clone(),
            self.config.clone(),
            self.limits.clone(),
            rx,
        ));
        map.insert(
            document_id.as_str().to_owned(),
            RoomEntry {
                tx: tx.clone(),
                handle,
            },
        );
        Ok(tx)
    }

    pub async fn join(
        &self,
        document_id: &DocumentId,
        actor: RoomActor,
        client_version: Option<esbt::clock::Version>,
        out: mpsc::Sender<OutMsg>,
    ) -> Result<JoinedRoom, JoinRefusal> {
        let tx = self
            .entry_tx(document_id)
            .await
            .map_err(|_| JoinRefusal::Gone)?;
        let (resp, rx) = oneshot::channel();
        tx.send(RoomMsg::Join {
            actor,
            client_version,
            out,
            resp,
        })
        .await
        .map_err(|_| JoinRefusal::Internal)?;
        let conn = rx.await.map_err(|_| JoinRefusal::Internal)??;
        Ok(JoinedRoom { conn, tx })
    }

    /// Read live state from a resident room, if one is resident.
    pub async fn read(&self, document_id: &DocumentId) -> Option<RoomRead> {
        let tx = {
            let map = self.map.lock().await;
            map.get(document_id.as_str())
                .filter(|entry| !entry.tx.is_closed())
                .map(|entry| entry.tx.clone())?
        };
        let (resp, rx) = oneshot::channel();
        tx.send(RoomMsg::Read { resp }).await.ok()?;
        rx.await.ok()
    }

    /// Deliver a revocation/epoch signal to every resident room. Rooms apply
    /// it before processing another inbound frame; durable mutations also
    /// re-check the epoch in their own transaction.
    pub async fn control(&self, control: Control) {
        let targets: Vec<mpsc::Sender<RoomMsg>> = {
            let map = self.map.lock().await;
            match &control {
                Control::Deleted { document_id } | Control::EpochChanged { document_id, .. } => map
                    .get(document_id.as_str())
                    .map(|entry| entry.tx.clone())
                    .into_iter()
                    .collect(),
                _ => map.values().map(|entry| entry.tx.clone()).collect(),
            }
        };
        for tx in targets {
            let _ = tx.send(RoomMsg::Control(control.clone())).await;
        }
        if let Control::Deleted { document_id } = &control {
            let mut map = self.map.lock().await;
            map.remove(document_id.as_str());
        }
    }

    /// Flush every resident room and stop. Correctness never depends on this
    /// (the journal is already durable); it compacts eagerly on the way out.
    pub async fn shutdown(&self) {
        let entries: Vec<RoomEntry> = {
            let mut map = self.map.lock().await;
            map.drain().map(|(_, entry)| entry).collect()
        };
        for entry in entries {
            let (resp, rx) = oneshot::channel();
            if entry.tx.send(RoomMsg::Shutdown { resp }).await.is_ok() {
                let _ = rx.await;
            }
            let _ = entry.handle.await;
        }
    }
}
