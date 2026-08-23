//! The single owner task for one document's live replica.
//!
//! Order of operations for a client update, per `docs/V1-SCOPE.md`: validate
//! actor and payload, apply to the staged in-memory replica, commit the exact
//! canonical bytes to the journal in one transaction, and only then broadcast.
//! A persistence failure never acknowledges or broadcasts; the room poisons
//! itself and clients rehydrate from the durable journal on reconnect.

use super::{
    CLOSE_DOCUMENT_DELETED, CLOSE_FORBIDDEN_WRITE, CLOSE_INTERNAL, CLOSE_INVALID_PAYLOAD,
    CLOSE_UNAUTHORIZED, Control, JoinRefusal, MSG_EPHEMERAL, MSG_SERVER_VV, MSG_SNAPSHOT,
    MSG_SYNCED, MSG_UPDATE, OutMsg, RoomMsg, RoomRead, frame,
};
use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::ids::now_ms;
use crate::store;
use esbt::ErrorCode;
use marks_auth::{DocumentAction, DocumentId, RoomActor, authorize_room_action};
use rusqlite::params;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Presence frames are relayed, never persisted; bound them separately.
const MAX_EPHEMERAL_BYTES: usize = 64 * 1024;

struct Socket {
    actor: RoomActor,
    out: mpsc::Sender<OutMsg>,
}

struct Room {
    document_id: DocumentId,
    db: Arc<Db>,
    config: Arc<Config>,
    document: esbt::Document,
    /// Last committed journal revision.
    revision: u64,
    /// Journal rows since the last snapshot compaction.
    since_compact: u64,
    epoch: u64,
    sockets: HashMap<u64, Socket>,
    next_conn: u64,
    dead: Option<u16>,
}

pub(super) async fn run(
    document_id: DocumentId,
    db: Arc<Db>,
    config: Arc<Config>,
    limits: esbt::ResourceLimits,
    mut rx: mpsc::Receiver<RoomMsg>,
) {
    let hydrated = db.read(|conn| {
        let row = store::load_document(conn, &document_id)?.ok_or_else(ApiError::not_found)?;
        if row.record.deleted_at_ms.is_some() {
            return Err(ApiError::not_found());
        }
        let (document, revision) = store::hydrate_document(conn, &document_id, &limits)?;
        Ok((document, revision, row.record.authorization_epoch))
    });
    let mut room = match hydrated {
        Ok((document, revision, epoch)) => Room {
            document_id,
            db,
            config,
            document,
            revision,
            since_compact: 0,
            epoch,
            sockets: HashMap::new(),
            next_conn: 1,
            dead: None,
        },
        Err(_) => {
            // Refuse every join and drain; the manager entry drops with us.
            while let Some(message) = rx.recv().await {
                match message {
                    RoomMsg::Join { resp, .. } => {
                        let _ = resp.send(Err(JoinRefusal::Gone));
                    }
                    RoomMsg::Shutdown { resp } => {
                        let _ = resp.send(());
                        return;
                    }
                    _ => {}
                }
            }
            return;
        }
    };

    while let Some(message) = rx.recv().await {
        match message {
            RoomMsg::Join {
                actor,
                client_version,
                out,
                resp,
            } => {
                let _ = resp.send(room.join(actor, client_version, out));
            }
            RoomMsg::Frame { conn, data } => room.frame(conn, data),
            RoomMsg::Leave { conn } => {
                room.sockets.remove(&conn);
                if room.sockets.is_empty() && room.dead.is_none() {
                    room.compact(true);
                }
            }
            RoomMsg::Control(control) => room.control(control),
            RoomMsg::Read { resp } => {
                let _ = resp.send(room.read());
            }
            RoomMsg::Shutdown { resp } => {
                if room.dead.is_none() {
                    room.compact(true);
                }
                room.close_all(CLOSE_INTERNAL);
                let _ = resp.send(());
                return;
            }
        }
    }
    if room.dead.is_none() {
        room.compact(true);
    }
}

impl Room {
    fn join(
        &mut self,
        actor: RoomActor,
        client_version: Option<esbt::clock::Version>,
        out: mpsc::Sender<OutMsg>,
    ) -> Result<u64, JoinRefusal> {
        if self.dead.is_some() {
            return Err(JoinRefusal::Gone);
        }
        let actor_epoch = match &actor {
            RoomActor::Principal(actor) => actor.authorization_epoch,
            RoomActor::Scratch(actor) => actor.authorization_epoch,
        };
        if actor_epoch != self.epoch {
            return Err(JoinRefusal::Stale);
        }

        // Initial sync: the server's version, then a delta when the client's
        // version still covers retained history, otherwise a full snapshot.
        let mut initial = vec![frame(MSG_SERVER_VV, &self.document.version().encode())];
        let delta = client_version
            .as_ref()
            .and_then(|version| self.document.export_update(version).ok());
        match delta {
            Some(bytes) => initial.push(frame(MSG_UPDATE, &bytes)),
            None => match self.document.export_full_snapshot() {
                Ok(snapshot) => initial.push(frame(MSG_SNAPSHOT, &snapshot)),
                Err(error) => {
                    tracing::error!(
                        target: "marks_server::room",
                        document = self.document_id.as_str(),
                        code = ?error.code,
                        "snapshot export failed during join"
                    );
                    return Err(JoinRefusal::Internal);
                }
            },
        }
        initial.push(frame(MSG_SYNCED, &[]));
        for message in initial {
            if out.try_send(OutMsg::Frame(message)).is_err() {
                return Err(JoinRefusal::Internal);
            }
        }

        let conn = self.next_conn;
        self.next_conn += 1;
        self.sockets.insert(conn, Socket { actor, out });
        Ok(conn)
    }

    fn frame(&mut self, conn: u64, data: Vec<u8>) {
        if self.dead.is_some() || data.is_empty() {
            return;
        }
        if data.len() > self.config.max_frame_bytes {
            self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            return;
        }
        let tag = data[0];
        let payload = &data[1..];
        match tag {
            MSG_UPDATE => self.client_update(conn, payload),
            MSG_SNAPSHOT => self.client_snapshot(conn, payload),
            MSG_EPHEMERAL => self.client_ephemeral(conn, payload),
            // Unknown client tags are ignored, not fatal: forward-compatible.
            _ => {}
        }
    }

    fn client_snapshot(&mut self, conn: u64, payload: &[u8]) {
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        if !authorize_room_action(&socket.actor, DocumentAction::EditText) {
            self.close_one(conn, CLOSE_FORBIDDEN_WRITE);
            return;
        }
        if !snapshot_envelope(payload) {
            self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            return;
        }
        match self.document.apply_snapshot_bytes(payload) {
            Ok(receipt) => {
                if !receipt.visible_changed {
                    return;
                }
                // A compact-snapshot rebase is the HistoryUnavailable fallback.
                // Persist the merged replica as compaction, then relay the
                // exact client bytes so other peers can import them.
                self.since_compact = self.since_compact.max(1);
                self.compact(true);
                self.broadcast(conn, frame(MSG_SNAPSHOT, payload));
            }
            Err(error) => {
                if resource_pressure(&error.code) {
                    tracing::warn!(
                        target: "marks_server::room",
                        document = self.document_id.as_str(),
                        code = ?error.code,
                        "snapshot rejected by resource policy"
                    );
                }
                self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            }
        }
    }

    /// Role policy runs before any CRDT decoding; rejected writers cannot
    /// cause journal appends, broadcasts, or engine state changes.
    fn client_update(&mut self, conn: u64, payload: &[u8]) {
        if snapshot_envelope(payload) {
            self.client_snapshot(conn, payload);
            return;
        }
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        if !authorize_room_action(&socket.actor, DocumentAction::EditText) {
            self.close_one(conn, CLOSE_FORBIDDEN_WRITE);
            return;
        }

        let receipt = match self.document.apply_bytes(payload) {
            Ok(receipt) => receipt,
            Err(error) => {
                if resource_pressure(&error.code) {
                    tracing::warn!(
                        target: "marks_server::room",
                        document = self.document_id.as_str(),
                        code = ?error.code,
                        "update rejected by resource policy"
                    );
                }
                self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                return;
            }
        };
        let Some(journal_bytes) = receipt.journal_bytes.clone() else {
            // Retry-safe: an entirely duplicate update commits nothing and
            // is acknowledged by silence; the client's state already covers it.
            return;
        };

        match self.persist(conn, &journal_bytes, &receipt) {
            Ok(()) => self.broadcast(conn, frame(MSG_UPDATE, &journal_bytes)),
            Err(close_code) => {
                // The staged replica is ahead of the journal. Drop the room:
                // reconnecting clients rehydrate from durable state and re-send
                // their uncommitted operations through the version-vector path.
                tracing::error!(
                    target: "marks_server::room",
                    document = self.document_id.as_str(),
                    "journal append failed; poisoning room"
                );
                self.close_all(close_code);
                self.dead = Some(close_code);
            }
        }
    }

    fn persist(
        &mut self,
        conn: u64,
        journal_bytes: &[u8],
        receipt: &esbt::ApplyReceipt,
    ) -> Result<(), u16> {
        let Some(socket) = self.sockets.get(&conn) else {
            return Err(CLOSE_INTERNAL);
        };
        let (actor_kind, actor_id, session_id) = match &socket.actor {
            RoomActor::Principal(actor) => (
                "principal",
                actor.principal_id.as_str().to_owned(),
                Some(actor.session_id.as_str().to_owned()),
            ),
            RoomActor::Scratch(actor) => ("scratch", actor.scratch_id.as_str().to_owned(), None),
        };
        let next_revision = self.revision + 1;
        let epoch = self.epoch;
        let document_id = self.document_id.clone();
        let now = now_ms();
        let text = self.document.text();
        let chars = self.document.len() as u64;

        let committed: ApiResult<()> = self.db.tx(|db| {
            let row = store::load_document(db, &document_id)?.ok_or_else(ApiError::not_found)?;
            if row.record.deleted_at_ms.is_some() {
                return Err(ApiError::not_found());
            }
            // A missed in-memory control event cannot authorize a write: the
            // journal transaction re-checks the live authorization epoch.
            if row.record.authorization_epoch != epoch {
                return Err(ApiError::conflict());
            }
            db.execute(
                "INSERT INTO document_updates
                    (document_id, revision, payload, actor_kind, actor_id, session_id, received_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    document_id.as_str(),
                    store::ms(next_revision),
                    journal_bytes,
                    actor_kind,
                    actor_id,
                    session_id,
                    store::ms(now),
                ],
            )?;
            for operation in &receipt.accepted_operations {
                db.execute(
                    "INSERT OR IGNORE INTO op_authors
                        (document_id, site, seq, actor_kind, actor_id, session_id, received_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        document_id.as_str(),
                        operation.origin.to_string(),
                        store::ms(operation.sequence),
                        actor_kind,
                        actor_id,
                        session_id,
                        store::ms(now),
                    ],
                )?;
            }
            if row.title_explicit {
                db.execute(
                    "UPDATE documents SET chars = ?2, updated_at = ?3 WHERE id = ?1",
                    params![document_id.as_str(), store::ms(chars), store::ms(now)],
                )?;
            } else {
                db.execute(
                    "UPDATE documents SET chars = ?2, updated_at = ?3, title = ?4 WHERE id = ?1",
                    params![
                        document_id.as_str(),
                        store::ms(chars),
                        store::ms(now),
                        store::derive_title(&text),
                    ],
                )?;
            }
            Ok(())
        });

        match committed {
            Ok(()) => {
                self.revision = next_revision;
                self.since_compact += 1;
                if self.since_compact >= self.config.compact_every_updates {
                    self.compact(false);
                }
                Ok(())
            }
            Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {
                Err(CLOSE_DOCUMENT_DELETED)
            }
            Err(error) if error.status == axum::http::StatusCode::CONFLICT => {
                Err(CLOSE_UNAUTHORIZED)
            }
            Err(_) => Err(CLOSE_INTERNAL),
        }
    }

    fn client_ephemeral(&mut self, conn: u64, payload: &[u8]) {
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        // Presence is best-effort, allowed for every admitted role, relayed
        // only inside this room, and never persisted or snapshotted.
        if payload.len() > MAX_EPHEMERAL_BYTES
            || !authorize_room_action(&socket.actor, DocumentAction::PublishPresence)
        {
            return;
        }
        self.broadcast(conn, frame(MSG_EPHEMERAL, payload));
    }

    fn broadcast(&mut self, from: u64, message: Vec<u8>) {
        let mut evicted = Vec::new();
        for (&conn, socket) in &self.sockets {
            if conn == from {
                continue;
            }
            // A slow client that cannot drain its bounded queue is evicted
            // rather than allowed to stall the room.
            if socket.out.try_send(OutMsg::Frame(message.clone())).is_err() {
                evicted.push(conn);
            }
        }
        for conn in evicted {
            self.close_one(conn, CLOSE_INTERNAL);
        }
    }

    fn control(&mut self, control: Control) {
        match control {
            Control::Deleted { document_id } => {
                if document_id == self.document_id.as_str() {
                    self.close_all(CLOSE_DOCUMENT_DELETED);
                    self.dead = Some(CLOSE_DOCUMENT_DELETED);
                }
            }
            Control::EpochChanged { document_id, epoch } => {
                if document_id == self.document_id.as_str() {
                    self.epoch = epoch;
                    self.reresolve_sockets();
                }
            }
            Control::SessionRevoked { session_id } => {
                self.close_matching(|actor| match actor {
                    RoomActor::Principal(actor) => actor.session_id.as_str() == session_id,
                    RoomActor::Scratch(_) => false,
                });
            }
            Control::DeviceRevoked { device_id } => {
                self.close_matching(|actor| match actor {
                    RoomActor::Principal(actor) => actor.device_id.as_str() == device_id,
                    RoomActor::Scratch(_) => false,
                });
            }
        }
    }

    /// Revocation and role downgrade affect open sockets: every actor is
    /// re-resolved against the store, demoted in place, or closed.
    fn reresolve_sockets(&mut self) {
        let document_id = self.document_id.clone();
        let epoch = self.epoch;
        let resolved: ApiResult<Vec<(u64, Option<RoomActor>)>> = self.db.read(|conn| {
            let row = store::load_document(conn, &document_id)?;
            let Some(row) = row.filter(|row| row.record.deleted_at_ms.is_none()) else {
                return Ok(self.sockets.keys().map(|&conn| (conn, None)).collect());
            };
            let acl = store::load_acl(conn, &document_id)?;
            let mut out = Vec::new();
            for (&conn_id, socket) in &self.sockets {
                let next = match &socket.actor {
                    RoomActor::Principal(actor) => {
                        marks_auth::resolve_document_role(&row.record, &actor.principal_id, &acl)
                            .ok()
                            .map(|role| {
                                RoomActor::Principal(marks_auth::Actor {
                                    role,
                                    authorization_epoch: epoch,
                                    ..actor.clone()
                                })
                            })
                    }
                    RoomActor::Scratch(actor) => {
                        let scratch = store::load_scratch(conn, &actor.scratch_id)?;
                        let live = scratch.is_some_and(|scratch| {
                            scratch.revoked_at_ms.is_none()
                                && scratch.claimed_by.is_none()
                                && now_ms() < scratch.expires_at_ms
                        });
                        let owns =
                            marks_auth::require_scratch_document(&row.record, &actor.scratch_id)
                                .is_ok();
                        (live && owns).then(|| {
                            RoomActor::Scratch(marks_auth::ScratchActor {
                                authorization_epoch: epoch,
                                ..actor.clone()
                            })
                        })
                    }
                };
                out.push((conn_id, next));
            }
            Ok(out)
        });
        match resolved {
            Ok(entries) => {
                for (conn, next) in entries {
                    match next {
                        Some(actor) => {
                            if let Some(socket) = self.sockets.get_mut(&conn) {
                                socket.actor = actor;
                            }
                        }
                        None => self.close_one(conn, CLOSE_UNAUTHORIZED),
                    }
                }
            }
            Err(_) => {
                // Fail closed: if authority cannot be re-proven, nobody keeps it.
                self.close_all(CLOSE_INTERNAL);
                self.dead = Some(CLOSE_INTERNAL);
            }
        }
    }

    fn close_matching(&mut self, matches: impl Fn(&RoomActor) -> bool) {
        let targets: Vec<u64> = self
            .sockets
            .iter()
            .filter(|(_, socket)| matches(&socket.actor))
            .map(|(&conn, _)| conn)
            .collect();
        for conn in targets {
            self.close_one(conn, CLOSE_UNAUTHORIZED);
        }
    }

    fn close_one(&mut self, conn: u64, code: u16) {
        if let Some(socket) = self.sockets.remove(&conn) {
            let _ = socket.out.try_send(OutMsg::Close(code));
        }
    }

    fn close_all(&mut self, code: u16) {
        let conns: Vec<u64> = self.sockets.keys().copied().collect();
        for conn in conns {
            self.close_one(conn, code);
        }
    }

    fn read(&self) -> RoomRead {
        RoomRead {
            text: self.document.text(),
            full_snapshot: self.document.export_full_snapshot().ok(),
            compact_snapshot: self.document.export_compact_snapshot().ok(),
            connections: self.sockets.len(),
        }
    }

    /// Snapshotting is asynchronous compaction. It never defines whether an
    /// edit is saved and never overwrites a newer revision.
    fn compact(&mut self, _force: bool) {
        if self.since_compact == 0 {
            return;
        }
        let snapshot = match self.document.export_full_snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::warn!(
                    target: "marks_server::room",
                    document = self.document_id.as_str(),
                    code = ?error.code,
                    "compaction skipped; snapshot export failed"
                );
                return;
            }
        };
        let document_id = self.document_id.clone();
        let revision = self.revision;
        let compacted: ApiResult<()> = self.db.tx(|conn| {
            conn.execute(
                "UPDATE documents SET snapshot = ?2, snapshot_revision = ?3
                 WHERE id = ?1 AND snapshot_revision < ?3 AND deleted_at IS NULL",
                params![document_id.as_str(), snapshot, store::ms(revision)],
            )?;
            conn.execute(
                "DELETE FROM document_updates WHERE document_id = ?1 AND revision <= ?2",
                params![document_id.as_str(), store::ms(revision)],
            )?;
            Ok(())
        });
        match compacted {
            Ok(()) => self.since_compact = 0,
            Err(_) => tracing::warn!(
                target: "marks_server::room",
                document = self.document_id.as_str(),
                "compaction transaction failed; journal retained"
            ),
        }
    }
}

fn snapshot_envelope(payload: &[u8]) -> bool {
    payload.len() >= 11
        && payload[0] == b'E'
        && payload[1] == b'S'
        && payload[2] == b'B'
        && payload[3] == b'M'
        && matches!(payload[6], 3 | 6)
}

fn resource_pressure(code: &ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::TooManyOperations
            | ErrorCode::DocumentTooLarge
            | ErrorCode::TooManyPendingOperations
            | ErrorCode::TooManyDeferredDeletes
            | ErrorCode::MessageTooLarge
    )
}
