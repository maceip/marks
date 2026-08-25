//! One live in-memory ESBT room per open document, owned by one task. The
//! room consumes only validated `RoomActor`s from the Marks auth boundary;
//! ESBT receives site IDs and bytes, never identity.

pub mod protocol;
mod task;
pub mod ws;

use crate::config::Config;
use crate::db::Db;
use crate::store;
use marks_auth::{DocumentId, RoomActor};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

const ROOM_QUEUE_CAPACITY: usize = 1_024;
const CONTROL_QUEUE_CAPACITY: usize = 64;
const ROOM_REPLY_TIMEOUT: Duration = Duration::from_secs(5);

/// Marks room frame tags (`client/src/collab/protocol.ts`).
pub const MSG_UPDATE: u8 = 0x01;
pub const MSG_EPHEMERAL: u8 = 0x02;
pub const MSG_SERVER_VV: u8 = 0x03;
pub const MSG_SNAPSHOT: u8 = 0x04;
pub const MSG_SYNCED: u8 = 0x05;
/// Versioned client-to-server durable mutation envelope.
pub const MSG_MUTATION: u8 = 0x06;
/// Server-to-origin durable commit receipt.
pub const MSG_COMMITTED: u8 = 0x07;
/// Marks-owned, transient presence messages. These are deliberately distinct
/// from durable ESBT snapshots and updates.
pub const MSG_PRESENCE_DELTA: u8 = 0x08;
pub const MSG_PRESENCE_SNAPSHOT: u8 = 0x09;
pub const MSG_PRESENCE_REMOVAL: u8 = 0x0a;

/// Close codes. `4404` is the one the browser treats as "document deleted".
pub const CLOSE_INVALID_PAYLOAD: u16 = 4400;
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
pub const CLOSE_FORBIDDEN_WRITE: u16 = 4403;
pub const CLOSE_DOCUMENT_DELETED: u16 = 4404;
/// Admission/rate capacity exhausted. Clients may retry with backoff and a new
/// one-use room ticket; the mutation remains in their durable local journal.
pub const CLOSE_CAPACITY: u16 = 4429;
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
    Capacity,
    Internal,
}

pub enum RoomMsg {
    Join {
        actor: Box<RoomActor>,
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
    Read {
        resp: oneshot::Sender<RoomRead>,
    },
    Shutdown {
        resp: oneshot::Sender<()>,
    },
}

struct RoomEntry {
    tx: mpsc::Sender<RoomMsg>,
    control_tx: mpsc::Sender<Control>,
    connections: Arc<AtomicUsize>,
    handle: JoinHandle<()>,
}

fn dispatch_control(map: &mut HashMap<String, RoomEntry>, control: &Control) -> Vec<RoomEntry> {
    let mut failed = Vec::new();
    let targets: Vec<String> = match control {
        Control::Deleted { document_id } | Control::EpochChanged { document_id, .. } => map
            .contains_key(document_id)
            .then(|| document_id.clone())
            .into_iter()
            .collect(),
        _ => map.keys().cloned().collect(),
    };
    for document_id in targets {
        let delivered = map
            .get(&document_id)
            .is_some_and(|entry| entry.control_tx.try_send(control.clone()).is_ok());
        let deleted = matches!(
            control,
            Control::Deleted {
                document_id: target
            } if target == &document_id
        );
        if (!delivered || deleted)
            && let Some(entry) = map.remove(&document_id)
            && !delivered
        {
            failed.push(entry);
        }
    }
    failed
}

/// Owner map of resident rooms. There is exactly one live replica per open
/// document in this process; rooms rehydrate from the journal on demand.
pub struct Rooms {
    db: Arc<Db>,
    config: Arc<Config>,
    limits: esbt::ResourceLimits,
    map: Arc<Mutex<HashMap<String, RoomEntry>>>,
    commit_batches: Arc<AtomicU64>,
    committed_mutations: Arc<AtomicU64>,
    presence: Arc<PresenceCounters>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CommitStats {
    pub batches: u64,
    pub mutations: u64,
}

#[derive(Default)]
pub(crate) struct PresenceCounters {
    pub received: AtomicU64,
    pub dropped: AtomicU64,
    pub coalesced: AtomicU64,
    pub broadcast: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PresenceStats {
    pub received: u64,
    pub dropped: u64,
    pub coalesced: u64,
    pub broadcast: u64,
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
            map: Arc::new(Mutex::new(HashMap::new())),
            commit_batches: Arc::new(AtomicU64::new(0)),
            committed_mutations: Arc::new(AtomicU64::new(0)),
            presence: Arc::new(PresenceCounters::default()),
        }
    }

    async fn entry_tx(
        &self,
        document_id: &DocumentId,
    ) -> Result<mpsc::Sender<RoomMsg>, JoinRefusal> {
        {
            let mut map = self.map.lock().unwrap_or_else(|poison| poison.into_inner());
            if let Some(entry) = map.get(document_id.as_str()) {
                if !entry.tx.is_closed() {
                    return Ok(entry.tx.clone());
                }
                map.remove(document_id.as_str());
            }
            if map.len() >= self.config.max_resident_rooms {
                return Err(JoinRefusal::Capacity);
            }
        }
        // Never create rooms for unknown or deleted documents.
        let live = self
            .db
            .read(|conn| {
                Ok(store::load_document(conn, document_id)?
                    .is_some_and(|row| row.record.deleted_at_ms.is_none()))
            })
            .map_err(|_| JoinRefusal::Internal)?;
        if !live {
            return Err(JoinRefusal::Gone);
        }
        // The database lookup above deliberately runs without the owner-map
        // lock. Re-check after it so duplicate concurrent admissions converge
        // on one task while room controls never wait behind SQLite I/O.
        let mut map = self.map.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(entry) = map.get(document_id.as_str()) {
            if !entry.tx.is_closed() {
                return Ok(entry.tx.clone());
            }
            map.remove(document_id.as_str());
        }
        if map.len() >= self.config.max_resident_rooms {
            return Err(JoinRefusal::Capacity);
        }
        let (tx, rx) = mpsc::channel(ROOM_QUEUE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
        let connections = Arc::new(AtomicUsize::new(0));
        let room_id = document_id.as_str().to_owned();
        let cleanup_map = self.map.clone();
        let room_tx = tx.clone();
        let task_document_id = document_id.clone();
        let task_db = self.db.clone();
        let task_config = self.config.clone();
        let task_limits = self.limits.clone();
        let task_commit_batches = self.commit_batches.clone();
        let task_committed_mutations = self.committed_mutations.clone();
        let task_presence = self.presence.clone();
        let task_connections = connections.clone();
        let handle = tokio::spawn(async move {
            let context = task::TaskContext {
                document_id: task_document_id,
                db: task_db,
                config: task_config,
                limits: task_limits,
                commit_batches: task_commit_batches,
                committed_mutations: task_committed_mutations,
                presence: task_presence,
                connections: task_connections,
            };
            task::run(context, rx, control_rx).await;
            let mut map = cleanup_map
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if map
                .get(&room_id)
                .is_some_and(|entry| entry.tx.same_channel(&room_tx))
            {
                map.remove(&room_id);
            }
        });
        map.insert(
            document_id.as_str().to_owned(),
            RoomEntry {
                tx: tx.clone(),
                control_tx,
                connections,
                handle,
            },
        );
        Ok(tx)
    }

    pub async fn resident_count(&self) -> usize {
        self.map
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len()
    }

    /// Process-lifetime counters make group-commit effectiveness observable
    /// without placing metrics or timestamps in the CRDT protocol.
    pub fn commit_stats(&self) -> CommitStats {
        CommitStats {
            batches: self.commit_batches.load(Ordering::Relaxed),
            mutations: self.committed_mutations.load(Ordering::Relaxed),
        }
    }

    /// Payload-free process counters for the intentionally lossy presence lane.
    pub fn presence_stats(&self) -> PresenceStats {
        PresenceStats {
            received: self.presence.received.load(Ordering::Relaxed),
            dropped: self.presence.dropped.load(Ordering::Relaxed),
            coalesced: self.presence.coalesced.load(Ordering::Relaxed),
            broadcast: self.presence.broadcast.load(Ordering::Relaxed),
        }
    }

    pub async fn join(
        &self,
        document_id: &DocumentId,
        actor: RoomActor,
        client_version: Option<esbt::clock::Version>,
        out: mpsc::Sender<OutMsg>,
    ) -> Result<JoinedRoom, JoinRefusal> {
        let tx = self.entry_tx(document_id).await?;
        let (resp, rx) = oneshot::channel();
        tx.try_send(RoomMsg::Join {
            actor: Box::new(actor),
            client_version,
            out,
            resp,
        })
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => JoinRefusal::Capacity,
            mpsc::error::TrySendError::Closed(_) => JoinRefusal::Internal,
        })?;
        let conn = tokio::time::timeout(ROOM_REPLY_TIMEOUT, rx)
            .await
            .map_err(|_| JoinRefusal::Capacity)?
            .map_err(|_| JoinRefusal::Internal)??;
        Ok(JoinedRoom { conn, tx })
    }

    /// Cheap best-effort metadata: no room message, snapshot export, or await.
    /// A contended owner map reports zero through `None` instead of delaying a
    /// document GET behind room creation or teardown.
    pub fn connection_count(&self, document_id: &DocumentId) -> Option<usize> {
        let map = self.map.try_lock().ok()?;
        map.get(document_id.as_str())
            .filter(|entry| !entry.tx.is_closed())
            .map(|entry| entry.connections.load(Ordering::Acquire))
    }

    /// Read live state from a resident room, if one is resident.
    pub async fn read(&self, document_id: &DocumentId) -> Option<RoomRead> {
        let tx = {
            let map = self.map.lock().unwrap_or_else(|poison| poison.into_inner());
            map.get(document_id.as_str())
                .filter(|entry| !entry.tx.is_closed())
                .map(|entry| entry.tx.clone())?
        };
        let (resp, rx) = oneshot::channel();
        tx.try_send(RoomMsg::Read { resp }).ok()?;
        tokio::time::timeout(ROOM_REPLY_TIMEOUT, rx)
            .await
            .ok()?
            .ok()
    }

    /// Deliver a revocation/epoch signal to every resident room. Rooms apply
    /// it before processing another inbound frame; durable mutations also
    /// re-check the epoch in their own transaction.
    pub fn control(&self, control: Control) {
        let mut map = self.map.lock().unwrap_or_else(|poison| poison.into_inner());
        let failed = dispatch_control(&mut map, &control);
        drop(map);
        // A full or closed priority lane cannot be allowed to preserve stale
        // authority. Abort that room task; its receiver disappears and no
        // queued mutation can reach durable storage.
        for entry in failed {
            entry.handle.abort();
        }
    }

    /// Flush every resident room and stop. Correctness never depends on this
    /// (the journal is already durable); it compacts eagerly on the way out.
    pub async fn shutdown(&self) {
        let entries: Vec<RoomEntry> = {
            let mut map = self.map.lock().unwrap_or_else(|poison| poison.into_inner());
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

#[cfg(test)]
mod manager_tests {
    use super::*;

    #[tokio::test]
    async fn saturated_priority_control_lane_evicts_the_room_fail_closed() {
        let (tx, _rx) = mpsc::channel(1);
        let (control_tx, _control_rx) = mpsc::channel(1);
        control_tx
            .try_send(Control::SessionRevoked {
                session_id: "session_first".to_owned(),
            })
            .unwrap();
        let handle = tokio::spawn(std::future::pending::<()>());
        let mut map = HashMap::from([(
            "document_test".to_owned(),
            RoomEntry {
                tx,
                control_tx,
                connections: Arc::new(AtomicUsize::new(1)),
                handle,
            },
        )]);

        let failed = dispatch_control(
            &mut map,
            &Control::DeviceRevoked {
                device_id: "device_second".to_owned(),
            },
        );
        assert!(map.is_empty());
        assert_eq!(failed.len(), 1);
        for entry in failed {
            entry.handle.abort();
            let _ = entry.handle.await;
        }
    }
}
