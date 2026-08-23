//! The single owner task for one document's live replica.
//!
//! Order of operations for a client update, per `docs/V1-SCOPE.md`: validate
//! actor and payload, apply to the staged in-memory replica, commit the exact
//! canonical bytes to the journal in one transaction, and only then broadcast.
//! A persistence failure never acknowledges or broadcasts; the room poisons
//! itself and clients rehydrate from the durable journal on reconnect.

use super::protocol::{Mutation, MutationKind, decode_mutation, encode_committed};
use super::{
    CLOSE_CAPACITY, CLOSE_DOCUMENT_DELETED, CLOSE_FORBIDDEN_WRITE, CLOSE_INTERNAL,
    CLOSE_INVALID_PAYLOAD, CLOSE_UNAUTHORIZED, Control, JoinRefusal, MSG_COMMITTED, MSG_EPHEMERAL,
    MSG_MUTATION, MSG_PRESENCE_DELTA, MSG_PRESENCE_REMOVAL, MSG_PRESENCE_SNAPSHOT, MSG_SERVER_VV,
    MSG_SNAPSHOT, MSG_SYNCED, MSG_UPDATE, OutMsg, RoomMsg, RoomRead, frame,
};
use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::ids::now_ms;
use crate::store;
use esbt::ErrorCode;
use esbt::clock::Version;
use esbt::snapshot::Message;
use marks_auth::{DocumentAction, DocumentId, RoomActor, authorize_room_action};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

/// Presence frames are relayed, never persisted; bound them separately.
const MAX_PRESENCE_BYTES_PER_CONNECTION: usize = 8 * 1024;
const MAX_PRESENCE_RECORDS_PER_CONNECTION: usize = 8;
const MAX_PRESENCE_KEY_BYTES: usize = 256;
const MAX_PRESENCE_VALUE_BYTES: usize = 4 * 1024;
const PRESENCE_SCHEMA_V1: u8 = 5;
/// Receipts older than this window may be recreated as duplicate CRDT commits;
/// their operations remain idempotent even after the receipt row is pruned.
const IDEMPOTENCY_RECEIPT_WINDOW: u64 = 65_536;

struct Socket {
    actor: RoomActor,
    out: mpsc::Sender<OutMsg>,
    mutation_window: u64,
    mutations_in_window: u32,
    mutation_bytes_in_window: usize,
}

#[derive(Default)]
struct PresenceState {
    /// Complete encoded records (key length through value), indexed so a
    /// cursor move replaces rather than accumulates history.
    records: HashMap<String, Vec<u8>>,
}

enum CommitLookup {
    Missing,
    Match(u64),
    Conflict,
}

struct ActorReceipt {
    kind: &'static str,
    id: String,
    session_id: Option<String>,
    site: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AcceptedRange {
    site: u128,
    first: u64,
    last: u64,
}

enum CommitAction {
    /// The CRDT already covered these bytes; only the retry receipt is new.
    Receipt,
    Update {
        journal: Vec<u8>,
        accepted_operations: Vec<(String, u64)>,
        chars: u64,
    },
    Snapshot {
        compact: Vec<u8>,
        accepted_ranges: Vec<AcceptedRange>,
        chars: u64,
    },
}

struct PreparedCommit {
    conn: u64,
    id: [u8; 16],
    kind: MutationKind,
    digest: [u8; 32],
    revision: u64,
    version: Vec<u8>,
    actor: ActorReceipt,
    committed_at: u64,
    action: CommitAction,
    relay: Option<Vec<u8>>,
}

struct PendingAck {
    conn: u64,
    id: [u8; 16],
    revision: u64,
    version: Vec<u8>,
}

struct SeenMutation {
    kind: MutationKind,
    digest: [u8; 32],
    revision: u64,
    version: Vec<u8>,
}

type SeenMutations = HashMap<[u8; 16], SeenMutation>;

fn read_presence_uint(bytes: &[u8], offset: &mut usize) -> Option<usize> {
    let mut value = 0usize;
    let mut shift = 0u32;
    loop {
        let byte = *bytes.get(*offset)?;
        *offset += 1;
        let part = usize::from(byte & 0x7f).checked_shl(shift)?;
        value = value.checked_add(part)?;
        if byte & 0x80 == 0 {
            if shift != 0 && byte == 0 {
                return None;
            }
            return Some(value);
        }
        shift = shift.checked_add(7)?;
        if shift >= usize::BITS {
            return None;
        }
    }
}

fn read_presence_bytes<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
    maximum: usize,
) -> Option<&'a [u8]> {
    let length = read_presence_uint(bytes, offset)?;
    if length > maximum {
        return None;
    }
    let end = offset.checked_add(length)?;
    let value = bytes.get(*offset..end)?;
    *offset = end;
    Some(value)
}

/// Decode the legacy v1 Marks record encoding, but bind every key to the
/// authenticated actor's ESBT site. This prevents one socket from replacing or
/// deleting another actor's cursor by forging its key.
fn decode_presence(bytes: &[u8], instance: &str) -> Option<Vec<(String, Option<Vec<u8>>)>> {
    if bytes.len() > MAX_PRESENCE_BYTES_PER_CONNECTION
        || bytes.first().copied()? != PRESENCE_SCHEMA_V1
    {
        return None;
    }
    let mut offset = 1;
    let count = read_presence_uint(bytes, &mut offset)?;
    if count > MAX_PRESENCE_RECORDS_PER_CONNECTION {
        return None;
    }
    let prefix = format!("{instance}-");
    let mut changes = Vec::with_capacity(count);
    for _ in 0..count {
        let start = offset;
        let key_bytes = read_presence_bytes(bytes, &mut offset, MAX_PRESENCE_KEY_BYTES)?;
        let key = std::str::from_utf8(key_bytes).ok()?.to_owned();
        if key_bytes.is_empty()
            || !key.starts_with(&prefix)
            || changes.iter().any(|(seen, _)| seen == &key)
        {
            return None;
        }
        match *bytes.get(offset)? {
            1 => {
                offset += 1;
                changes.push((key, None));
            }
            0 => {
                offset += 1;
                read_presence_uint(bytes, &mut offset)?; // client-reported age
                let json = read_presence_bytes(bytes, &mut offset, MAX_PRESENCE_VALUE_BYTES)?;
                serde_json::from_slice::<serde_json::Value>(json).ok()?;
                changes.push((key, Some(bytes[start..offset].to_vec())));
            }
            _ => return None,
        }
    }
    (offset == bytes.len()).then_some(changes)
}

fn push_presence_uint(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

fn encode_presence(records: &HashMap<String, Vec<u8>>) -> Vec<u8> {
    let mut ordered: Vec<_> = records.iter().collect();
    ordered.sort_unstable_by_key(|(key, _)| *key);
    let mut out = vec![PRESENCE_SCHEMA_V1];
    push_presence_uint(&mut out, ordered.len());
    for (_, record) in ordered {
        out.extend_from_slice(record);
    }
    out
}

fn encode_presence_changes(mut changes: Vec<(String, Option<Vec<u8>>)>) -> Vec<u8> {
    changes.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    let mut out = vec![PRESENCE_SCHEMA_V1];
    push_presence_uint(&mut out, changes.len());
    for (key, record) in changes {
        if let Some(record) = record {
            out.extend_from_slice(&record);
        } else {
            push_presence_uint(&mut out, key.len());
            out.extend_from_slice(key.as_bytes());
            out.push(1);
        }
    }
    out
}

struct Room {
    document_id: DocumentId,
    db: Arc<Db>,
    config: Arc<Config>,
    limits: esbt::ResourceLimits,
    document: esbt::Document,
    /// Last committed journal revision.
    revision: u64,
    /// Journal rows since the last snapshot compaction.
    since_compact: u64,
    epoch: u64,
    sockets: HashMap<u64, Socket>,
    /// Process-local only: never passed to `store` or an ESBT snapshot.
    presence: HashMap<u64, PresenceState>,
    next_conn: u64,
    dead: Option<u16>,
    commit_batches: Arc<AtomicU64>,
    committed_mutations: Arc<AtomicU64>,
}

pub(super) async fn run(
    document_id: DocumentId,
    db: Arc<Db>,
    config: Arc<Config>,
    limits: esbt::ResourceLimits,
    commit_batches: Arc<AtomicU64>,
    committed_mutations: Arc<AtomicU64>,
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
            limits,
            document,
            revision,
            since_compact: 0,
            epoch,
            sockets: HashMap::new(),
            presence: HashMap::new(),
            next_conn: 1,
            dead: None,
            commit_batches,
            committed_mutations,
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

    let mut deferred = None;

    loop {
        let message = if deferred.is_some() {
            deferred.take()
        } else if room.sockets.is_empty() && room.dead.is_none() {
            match tokio::time::timeout(
                std::time::Duration::from_millis(room.config.room_idle_ms),
                rx.recv(),
            )
            .await
            {
                Ok(message) => message,
                Err(_) => {
                    room.compact(true);
                    return;
                }
            }
        } else {
            rx.recv().await
        };
        let Some(message) = message else {
            break;
        };
        match message {
            RoomMsg::Join {
                actor,
                client_version,
                out,
                resp,
            } => {
                let _ = resp.send(room.join(actor, client_version, out));
            }
            RoomMsg::Frame { conn, data } => {
                let mut frames = vec![(conn, data)];
                let deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_millis(room.config.commit_batch_delay_ms);
                while frames.len() < room.config.commit_batch_max {
                    match tokio::time::timeout_at(deadline, rx.recv()).await {
                        Ok(Some(RoomMsg::Frame { conn, data })) => frames.push((conn, data)),
                        Ok(Some(other)) => {
                            deferred = Some(other);
                            break;
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
                room.frames(frames);
            }
            RoomMsg::Leave { conn } => {
                room.remove_socket(conn, None);
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
        if self.sockets.len() >= self.config.max_connections_per_room {
            return Err(JoinRefusal::Capacity);
        }

        // Initial sync: the server's version, then a delta when the client's
        // version still covers retained history, otherwise a full snapshot.
        let mut initial = Vec::new();
        // Presence bootstraps precede the durable synced boundary and carry a
        // presence-specific tag, so they cannot be mistaken for ESBT state.
        for state in self.presence.values() {
            initial.push(frame(
                MSG_PRESENCE_SNAPSHOT,
                &encode_presence(&state.records),
            ));
        }
        initial.push(frame(MSG_SERVER_VV, &self.document.version().encode()));
        let delta = client_version
            .as_ref()
            .and_then(|version| self.document.export_update(version).ok());
        match delta {
            Some(bytes) => initial.push(frame(MSG_UPDATE, &bytes)),
            None => match self
                .document
                .export_compact_snapshot()
                .or_else(|_| self.document.export_full_snapshot())
            {
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
        self.sockets.insert(
            conn,
            Socket {
                actor,
                out,
                mutation_window: now_ms() / 1_000,
                mutations_in_window: 0,
                mutation_bytes_in_window: 0,
            },
        );
        Ok(conn)
    }

    fn frames(&mut self, frames: Vec<(u64, Vec<u8>)>) {
        if self.dead.is_some() {
            return;
        }

        let durable_version = self.document.version().encode();
        let mut next_revision = self.revision;
        let mut next_since_compact = self.since_compact;
        let mut prepared = Vec::new();
        let mut pending_acks = Vec::new();
        let mut seen = SeenMutations::new();

        for (conn, data) in frames {
            if self.dead.is_some() {
                return;
            }
            if data.is_empty() {
                continue;
            }
            if data.len() > self.config.max_frame_bytes {
                self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                continue;
            }
            let tag = data[0];
            let payload = &data[1..];
            match tag {
                MSG_MUTATION => {
                    if !self.allow_mutation(conn, payload.len()) {
                        self.close_one(conn, CLOSE_CAPACITY);
                        continue;
                    }
                    self.prepare_mutation(
                        conn,
                        payload,
                        &durable_version,
                        &mut next_revision,
                        &mut next_since_compact,
                        &mut prepared,
                        &mut pending_acks,
                        &mut seen,
                    );
                }
                MSG_EPHEMERAL | MSG_PRESENCE_DELTA => self.client_presence(conn, payload),
                // These tags are server-to-client engine state. A stale client
                // must fail closed instead of believing an unacknowledged
                // legacy write was saved.
                MSG_UPDATE | MSG_SNAPSHOT => self.close_one(conn, CLOSE_INVALID_PAYLOAD),
                // Unknown client tags are ignored, not fatal: forward-compatible.
                _ => {}
            }
        }

        if self.dead.is_some() {
            return;
        }
        if prepared.is_empty() {
            for ack in pending_acks {
                self.acknowledge(ack.conn, ack.id, ack.revision, &ack.version);
            }
            return;
        }
        self.commit_batch(prepared, pending_acks, next_revision, next_since_compact);
    }

    fn allow_mutation(&mut self, conn: u64, bytes: usize) -> bool {
        let Some(socket) = self.sockets.get_mut(&conn) else {
            return false;
        };
        let window = now_ms() / 1_000;
        if socket.mutation_window != window {
            socket.mutation_window = window;
            socket.mutations_in_window = 0;
            socket.mutation_bytes_in_window = 0;
        }
        socket.mutations_in_window = socket.mutations_in_window.saturating_add(1);
        socket.mutation_bytes_in_window = socket.mutation_bytes_in_window.saturating_add(bytes);
        socket.mutations_in_window <= self.config.max_mutations_per_second
            && socket.mutation_bytes_in_window <= self.config.max_mutation_bytes_per_second
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_mutation(
        &mut self,
        conn: u64,
        encoded: &[u8],
        durable_version: &[u8],
        next_revision: &mut u64,
        next_since_compact: &mut u64,
        prepared: &mut Vec<PreparedCommit>,
        pending_acks: &mut Vec<PendingAck>,
        seen: &mut SeenMutations,
    ) {
        let Some(mutation) = decode_mutation(encoded) else {
            self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            return;
        };
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        if !authorize_room_action(&socket.actor, DocumentAction::EditText) {
            self.close_one(conn, CLOSE_FORBIDDEN_WRITE);
            return;
        }

        let is_snapshot = snapshot_envelope(mutation.payload);
        if (mutation.kind == MutationKind::Snapshot) != is_snapshot {
            self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            return;
        }

        let digest = mutation_digest(&mutation);
        if let Some(prior) = seen.get(&mutation.id) {
            if prior.kind == mutation.kind && prior.digest == digest {
                pending_acks.push(PendingAck {
                    conn,
                    id: mutation.id,
                    revision: prior.revision,
                    version: prior.version.clone(),
                });
            } else {
                self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            }
            return;
        }
        match self.lookup_commit(&mutation, &digest) {
            Ok(CommitLookup::Match(revision)) => {
                pending_acks.push(PendingAck {
                    conn,
                    id: mutation.id,
                    revision,
                    version: durable_version.to_vec(),
                });
                return;
            }
            Ok(CommitLookup::Conflict) => {
                self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                return;
            }
            Ok(CommitLookup::Missing) => {}
            Err(code) => {
                self.poison(code, "commit receipt lookup failed");
                return;
            }
        }

        let actor = match self.actor_receipt(conn) {
            Ok(actor) => actor,
            Err(code) => {
                self.poison(code, "mutation actor disappeared");
                return;
            }
        };
        let committed_at = now_ms();
        let (revision, version, action, relay) = match mutation.kind {
            MutationKind::Update => {
                // Decode once on the hot path. A mutation may carry only the
                // immutable room site assigned to this actor; otherwise an
                // editor could forge another collaborator's operation origin.
                let update = match Message::decode_with_limits(mutation.payload, &self.limits) {
                    Ok(Message::Update(update))
                        if update.operations().iter().all(|operation| {
                            operation.origin == actor.site && sequence_fits_storage(operation.seq)
                        }) =>
                    {
                        update
                    }
                    Ok(Message::Update(_)) | Ok(_) | Err(_) => {
                        self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                        return;
                    }
                };
                let receipt = match self.document.apply_update(update) {
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
                let version = receipt.version.encode();
                match receipt.journal_bytes {
                    Some(journal) => {
                        let Some(revision) = next_revision.checked_add(1) else {
                            self.poison(CLOSE_INTERNAL, "document revision overflow");
                            return;
                        };
                        *next_revision = revision;
                        *next_since_compact = next_since_compact.saturating_add(1);
                        let accepted_operations = receipt
                            .accepted_operations
                            .into_iter()
                            .map(|operation| (operation.origin.to_string(), operation.sequence))
                            .collect();
                        (
                            revision,
                            version,
                            CommitAction::Update {
                                journal: journal.clone(),
                                accepted_operations,
                                chars: self.document.len() as u64,
                            },
                            Some(frame(MSG_UPDATE, &journal)),
                        )
                    }
                    None => (*next_revision, version, CommitAction::Receipt, None),
                }
            }
            MutationKind::Snapshot => {
                let before = self.document.version();
                // Snapshots may repeat state from other sites, but every
                // receipt newly introduced to the server must belong to the
                // submitting actor's assigned site.
                let incoming_version =
                    match Message::decode_with_limits(mutation.payload, &self.limits) {
                        Ok(Message::Snapshot(snapshot)) => snapshot.version,
                        Ok(Message::FullSnapshot(snapshot)) => snapshot.state.version,
                        Ok(_) | Err(_) => {
                            self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                            return;
                        }
                    };
                if !version_fits_storage(&incoming_version) {
                    self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                    return;
                }
                if version_has_new_site_other_than(&before, &incoming_version, actor.site) {
                    self.close_one(conn, CLOSE_INVALID_PAYLOAD);
                    return;
                }
                let receipt = match self.document.apply_snapshot_bytes(mutation.payload) {
                    Ok(receipt) => receipt,
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
                        return;
                    }
                };
                let version = receipt.version.encode();
                if receipt.version == before {
                    (*next_revision, version, CommitAction::Receipt, None)
                } else {
                    let accepted_ranges = new_receipt_ranges(&before, &receipt.version);
                    let compact = match self.document.export_compact_snapshot() {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            tracing::error!(
                                target: "marks_server::room",
                                document = self.document_id.as_str(),
                                code = ?error.code,
                                "merged recovery snapshot could not be made causally closed"
                            );
                            self.poison(CLOSE_INTERNAL, "snapshot canonicalization failed");
                            return;
                        }
                    };
                    let Some(revision) = next_revision.checked_add(1) else {
                        self.poison(CLOSE_INTERNAL, "document revision overflow");
                        return;
                    };
                    *next_revision = revision;
                    *next_since_compact = 0;
                    (
                        revision,
                        version,
                        CommitAction::Snapshot {
                            compact: compact.clone(),
                            accepted_ranges,
                            chars: self.document.len() as u64,
                        },
                        Some(frame(MSG_SNAPSHOT, &compact)),
                    )
                }
            }
        };

        seen.insert(
            mutation.id,
            SeenMutation {
                kind: mutation.kind,
                digest,
                revision,
                version: version.clone(),
            },
        );
        prepared.push(PreparedCommit {
            conn,
            id: mutation.id,
            kind: mutation.kind,
            digest,
            revision,
            version,
            actor,
            committed_at,
            action,
            relay,
        });
    }

    fn commit_batch(
        &mut self,
        prepared: Vec<PreparedCommit>,
        pending_acks: Vec<PendingAck>,
        next_revision: u64,
        next_since_compact: u64,
    ) {
        let should_compact = next_since_compact > 0
            && (next_since_compact >= self.config.compact_every_updates
                || self.document.retained_operations() >= self.config.compact_every_operations);
        let compact = if should_compact {
            match self.document.export_compact_snapshot() {
                Ok(snapshot) => Some(snapshot),
                Err(error) => {
                    tracing::error!(
                        target: "marks_server::room",
                        document = self.document_id.as_str(),
                        code = ?error.code,
                        "commit batch could not produce its compaction snapshot"
                    );
                    self.poison(CLOSE_INTERNAL, "batch compaction failed");
                    return;
                }
            }
        } else {
            None
        };

        let document_id = self.document_id.clone();
        let epoch = self.epoch;
        let receipt_cutoff = next_revision.saturating_sub(IDEMPOTENCY_RECEIPT_WINDOW);
        let metadata = prepared
            .iter()
            .rev()
            .find_map(|commit| match commit.action {
                CommitAction::Update { chars, .. } | CommitAction::Snapshot { chars, .. } => {
                    Some((chars, commit.committed_at))
                }
                CommitAction::Receipt => None,
            });
        let committed: ApiResult<()> = self.db.tx(|db| {
            require_live_epoch(db, &document_id, epoch)?;
            for commit in &prepared {
                match &commit.action {
                    CommitAction::Receipt => {}
                    CommitAction::Update {
                        journal,
                        accepted_operations,
                        ..
                    } => {
                        db.execute(
                            "INSERT INTO document_updates
                                (document_id, revision, payload, actor_kind, actor_id,
                                 session_id, received_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                document_id.as_str(),
                                store::ms(commit.revision),
                                journal,
                                commit.actor.kind,
                                commit.actor.id,
                                commit.actor.session_id,
                                store::ms(commit.committed_at),
                            ],
                        )?;
                        for (origin, sequence) in accepted_operations {
                            let sequence = store::exact_i64(*sequence)?;
                            db.execute(
                                "INSERT OR IGNORE INTO op_authors
                                    (document_id, site, seq, actor_kind, actor_id,
                                     session_id, received_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                                params![
                                    document_id.as_str(),
                                    origin,
                                    sequence,
                                    commit.actor.kind,
                                    commit.actor.id,
                                    commit.actor.session_id,
                                    store::ms(commit.committed_at),
                                ],
                            )?;
                        }
                    }
                    CommitAction::Snapshot {
                        compact,
                        accepted_ranges,
                        ..
                    } => {
                        for range in accepted_ranges {
                            let first = store::exact_i64(range.first)?;
                            let last = store::exact_i64(range.last)?;
                            db.execute(
                                "INSERT OR IGNORE INTO op_author_ranges
                                    (document_id, site, first_seq, last_seq, actor_kind,
                                     actor_id, session_id, received_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                                params![
                                    document_id.as_str(),
                                    range.site.to_string(),
                                    first,
                                    last,
                                    commit.actor.kind,
                                    commit.actor.id,
                                    commit.actor.session_id,
                                    store::ms(commit.committed_at),
                                ],
                            )?;
                        }
                        db.execute(
                            "UPDATE documents SET snapshot = ?2, snapshot_revision = ?3
                             WHERE id = ?1",
                            params![document_id.as_str(), compact, store::ms(commit.revision)],
                        )?;
                        db.execute(
                            "DELETE FROM document_updates
                             WHERE document_id = ?1 AND revision <= ?2",
                            params![document_id.as_str(), store::ms(commit.revision)],
                        )?;
                    }
                }
                insert_commit(db, &document_id, commit)?;
            }
            if let Some((chars, updated_at)) = metadata {
                update_document_metadata(db, &document_id, chars, updated_at)?;
            }
            if let Some(snapshot) = &compact {
                db.execute(
                    "UPDATE documents SET snapshot = ?2, snapshot_revision = ?3
                     WHERE id = ?1",
                    params![document_id.as_str(), snapshot, store::ms(next_revision)],
                )?;
                db.execute(
                    "DELETE FROM document_updates
                     WHERE document_id = ?1 AND revision <= ?2",
                    params![document_id.as_str(), store::ms(next_revision)],
                )?;
                db.execute(
                    "DELETE FROM document_commits
                     WHERE document_id = ?1 AND revision < ?2",
                    params![document_id.as_str(), store::ms(receipt_cutoff)],
                )?;
            }
            Ok(())
        });

        if let Err(code) = map_commit_result(committed) {
            self.poison(code, "batched durable commit failed");
            return;
        }

        self.revision = next_revision;
        self.commit_batches.fetch_add(1, Ordering::Relaxed);
        self.committed_mutations
            .fetch_add(prepared.len() as u64, Ordering::Relaxed);
        self.since_compact = if compact.is_some() {
            0
        } else {
            next_since_compact
        };
        if compact.is_some()
            || prepared
                .iter()
                .any(|commit| matches!(commit.action, CommitAction::Snapshot { .. }))
        {
            let version = self.document.version();
            if let Err(error) = self.document.prune_history_through(&version) {
                tracing::warn!(
                    target: "marks_server::room",
                    document = self.document_id.as_str(),
                    code = ?error.code,
                    "durable batch succeeded but live history prune failed"
                );
            }
        }

        for commit in prepared {
            self.acknowledge(commit.conn, commit.id, commit.revision, &commit.version);
            if let Some(message) = commit.relay {
                self.broadcast(commit.conn, message);
            }
        }
        for ack in pending_acks {
            self.acknowledge(ack.conn, ack.id, ack.revision, &ack.version);
        }
    }

    fn lookup_commit(
        &self,
        mutation: &Mutation<'_>,
        digest: &[u8; 32],
    ) -> Result<CommitLookup, u16> {
        let document_id = self.document_id.clone();
        self.db
            .read(|db| {
                let existing: Option<(Vec<u8>, i64, i64)> = db
                    .query_row(
                        "SELECT payload_hash, kind, revision FROM document_commits
                         WHERE document_id = ?1 AND message_id = ?2",
                        params![document_id.as_str(), mutation.id.as_slice()],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                Ok(match existing {
                    None => CommitLookup::Missing,
                    Some((stored_hash, kind, revision))
                        if stored_hash.as_slice() == digest
                            && kind == i64::from(mutation.kind as u8) =>
                    {
                        CommitLookup::Match(store::from_ms(revision))
                    }
                    Some(_) => CommitLookup::Conflict,
                })
            })
            .map_err(|_| CLOSE_INTERNAL)
    }

    fn actor_receipt(&self, conn: u64) -> Result<ActorReceipt, u16> {
        let socket = self.sockets.get(&conn).ok_or(CLOSE_INTERNAL)?;
        Ok(match &socket.actor {
            RoomActor::Principal(actor) => ActorReceipt {
                kind: "principal",
                id: actor.principal_id.as_str().to_owned(),
                session_id: Some(actor.session_id.as_str().to_owned()),
                site: actor.esbt_site.to_engine_site(),
            },
            RoomActor::Scratch(actor) => ActorReceipt {
                kind: "scratch",
                id: actor.scratch_id.as_str().to_owned(),
                session_id: None,
                site: actor.esbt_site.to_engine_site(),
            },
        })
    }

    fn acknowledge(&mut self, conn: u64, id: [u8; 16], revision: u64, version: &[u8]) {
        let Some(payload) = encode_committed(id, revision, version) else {
            self.poison(CLOSE_INTERNAL, "commit receipt encoding failed");
            return;
        };
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        if socket
            .out
            .try_send(OutMsg::Frame(frame(MSG_COMMITTED, &payload)))
            .is_err()
        {
            self.close_one(conn, CLOSE_INTERNAL);
        }
    }

    fn poison(&mut self, close_code: u16, reason: &'static str) {
        tracing::error!(
            target: "marks_server::room",
            document = self.document_id.as_str(),
            reason,
            "durable room poisoned"
        );
        self.close_all(close_code);
        self.dead = Some(close_code);
    }

    fn client_presence(&mut self, conn: u64, payload: &[u8]) {
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        if !authorize_room_action(&socket.actor, DocumentAction::PublishPresence) {
            return;
        }
        let instance = match &socket.actor {
            RoomActor::Principal(actor) => actor.esbt_site.to_engine_site().to_string(),
            RoomActor::Scratch(actor) => actor.esbt_site.to_engine_site().to_string(),
        };
        let Some(changes) = decode_presence(payload, &instance) else {
            self.close_one(conn, CLOSE_INVALID_PAYLOAD);
            return;
        };
        let state = self.presence.entry(conn).or_default();
        for (key, record) in changes {
            match record {
                Some(record) => {
                    state.records.insert(key, record);
                }
                None => {
                    state.records.remove(&key);
                }
            }
        }
        if state.records.len() > MAX_PRESENCE_RECORDS_PER_CONNECTION
            || encode_presence(&state.records).len() > MAX_PRESENCE_BYTES_PER_CONNECTION
        {
            self.close_one(conn, CLOSE_CAPACITY);
            return;
        }
        // Only the accepted, ownership-checked delta is relayed. The first
        // publication is therefore the moment existing members see a joiner.
        self.broadcast(conn, frame(MSG_PRESENCE_DELTA, payload));
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
        self.remove_socket(conn, Some(code));
    }

    fn remove_socket(&mut self, conn: u64, code: Option<u16>) {
        let removal = self.presence.remove(&conn).map(|state| {
            let records = state.records.into_keys().map(|key| (key, None)).collect();
            frame(MSG_PRESENCE_REMOVAL, &encode_presence_changes(records))
        });
        if let Some(socket) = self.sockets.remove(&conn)
            && let Some(code) = code
        {
            let _ = socket.out.try_send(OutMsg::Close(code));
        }
        if let Some(removal) = removal {
            self.broadcast(conn, removal);
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

    /// Compact a causally closed prefix after its journal revisions are already
    /// durable. A compact snapshot is bounded by materialized state rather than
    /// by every operation ever typed, and advances the engine history floor.
    fn compact(&mut self, _force: bool) {
        if self.since_compact == 0 {
            return;
        }
        let snapshot = match self.document.export_compact_snapshot() {
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
        let receipt_cutoff = revision.saturating_sub(IDEMPOTENCY_RECEIPT_WINDOW);
        let compacted: ApiResult<()> = self.db.tx(|conn| {
            let changed = conn.execute(
                "UPDATE documents SET snapshot = ?2, snapshot_revision = ?3
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![document_id.as_str(), snapshot, store::ms(revision)],
            )?;
            if changed != 1 {
                return Err(ApiError::not_found());
            }
            conn.execute(
                "DELETE FROM document_updates WHERE document_id = ?1 AND revision <= ?2",
                params![document_id.as_str(), store::ms(revision)],
            )?;
            conn.execute(
                "DELETE FROM document_commits WHERE document_id = ?1 AND revision < ?2",
                params![document_id.as_str(), store::ms(receipt_cutoff)],
            )?;
            Ok(())
        });
        match compacted {
            Ok(()) => {
                self.since_compact = 0;
                let version = self.document.version();
                if let Err(error) = self.document.prune_history_through(&version) {
                    tracing::warn!(
                        target: "marks_server::room",
                        document = self.document_id.as_str(),
                        code = ?error.code,
                        "durable compaction succeeded but live history prune failed"
                    );
                }
            }
            Err(_) => tracing::warn!(
                target: "marks_server::room",
                document = self.document_id.as_str(),
                "compaction transaction failed; journal retained"
            ),
        }
    }
}

fn mutation_digest(mutation: &Mutation<'_>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([mutation.kind as u8]);
    hasher.update(mutation.payload);
    hasher.finalize().into()
}

fn version_has_new_site_other_than(before: &Version, incoming: &Version, actor_site: u128) -> bool {
    incoming.receipts().any(|(site, contiguous, sparse)| {
        let introduces_receipt = before.observed(site) < contiguous
            || sparse
                .into_iter()
                .any(|sequence| !before.contains(site, sequence));
        introduces_receipt && site != actor_site
    })
}

const MAX_STORED_SEQUENCE: u64 = i64::MAX as u64;

fn sequence_fits_storage(sequence: u64) -> bool {
    sequence <= MAX_STORED_SEQUENCE
}

fn version_fits_storage(version: &Version) -> bool {
    version.receipts().all(|(_, contiguous, sparse)| {
        sequence_fits_storage(contiguous) && sparse.into_iter().all(sequence_fits_storage)
    })
}

/// Represent `after - before` without expanding contiguous prefixes. A compact
/// snapshot can legitimately summarize millions of historical receipts, so an
/// O(highest_sequence) attribution loop would itself be a denial-of-service.
fn new_receipt_ranges(before: &Version, after: &Version) -> Vec<AcceptedRange> {
    let mut ranges = Vec::new();
    for (site, contiguous, sparse_after) in after.receipts() {
        let first_missing = before.observed(site).saturating_add(1);
        if first_missing <= contiguous {
            let sparse_before = before
                .receipts()
                .find_map(|(candidate, _, sparse)| (candidate == site).then_some(sparse))
                .unwrap_or_default();
            let mut start = first_missing;
            for already_known in sparse_before {
                if already_known < start || already_known > contiguous {
                    continue;
                }
                if start < already_known {
                    push_accepted_range(&mut ranges, site, start, already_known - 1);
                }
                let Some(next) = already_known.checked_add(1) else {
                    start = u64::MAX;
                    break;
                };
                start = next;
            }
            if start <= contiguous {
                push_accepted_range(&mut ranges, site, start, contiguous);
            }
        }
        for sequence in sparse_after {
            if !before.contains(site, sequence) {
                push_accepted_range(&mut ranges, site, sequence, sequence);
            }
        }
    }
    ranges
}

fn push_accepted_range(ranges: &mut Vec<AcceptedRange>, site: u128, first: u64, last: u64) {
    if first == 0 || last < first {
        return;
    }
    if let Some(previous) = ranges.last_mut()
        && previous.site == site
        && previous.last.checked_add(1) == Some(first)
    {
        previous.last = last;
        return;
    }
    ranges.push(AcceptedRange { site, first, last });
}

fn require_live_epoch(
    db: &rusqlite::Connection,
    document_id: &DocumentId,
    epoch: u64,
) -> ApiResult<()> {
    let row = store::load_document(db, document_id)?.ok_or_else(ApiError::not_found)?;
    if row.record.deleted_at_ms.is_some() {
        return Err(ApiError::not_found());
    }
    // A missed in-memory control event cannot authorize a durable write.
    if row.record.authorization_epoch != epoch {
        return Err(ApiError::conflict());
    }
    Ok(())
}

fn insert_commit(
    db: &rusqlite::Connection,
    document_id: &DocumentId,
    commit: &PreparedCommit,
) -> ApiResult<()> {
    db.execute(
        "INSERT INTO document_commits
            (document_id, message_id, payload_hash, kind, revision,
             actor_kind, actor_id, session_id, committed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            document_id.as_str(),
            commit.id.as_slice(),
            commit.digest.as_slice(),
            i64::from(commit.kind as u8),
            store::ms(commit.revision),
            commit.actor.kind,
            commit.actor.id,
            commit.actor.session_id,
            store::ms(commit.committed_at),
        ],
    )?;
    Ok(())
}

fn update_document_metadata(
    db: &rusqlite::Connection,
    document_id: &DocumentId,
    chars: u64,
    now: u64,
) -> ApiResult<()> {
    db.execute(
        "UPDATE documents SET chars = ?2, updated_at = ?3 WHERE id = ?1",
        params![document_id.as_str(), store::ms(chars), store::ms(now)],
    )?;
    Ok(())
}

fn map_commit_result(result: ApiResult<()>) -> Result<(), u16> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {
            Err(CLOSE_DOCUMENT_DELETED)
        }
        Err(error) if error.status == axum::http::StatusCode::CONFLICT => Err(CLOSE_UNAUTHORIZED),
        Err(_) => Err(CLOSE_INTERNAL),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn presence_record(key: &str, json: &str) -> Vec<u8> {
        let mut bytes = vec![PRESENCE_SCHEMA_V1, 1];
        push_presence_uint(&mut bytes, key.len());
        bytes.extend_from_slice(key.as_bytes());
        bytes.push(0);
        bytes.push(0);
        push_presence_uint(&mut bytes, json.len());
        bytes.extend_from_slice(json.as_bytes());
        bytes
    }

    #[test]
    fn presence_boundary_enforces_schema_ownership_and_limits() {
        let valid = presence_record("42-cm-user", r#"{"name":"Viewer"}"#);
        assert_eq!(decode_presence(&valid, "42").unwrap().len(), 1);
        assert!(decode_presence(&valid, "43").is_none());

        let mut wrong_schema = valid.clone();
        wrong_schema[0] = PRESENCE_SCHEMA_V1 + 1;
        assert!(decode_presence(&wrong_schema, "42").is_none());

        let mut too_many = vec![PRESENCE_SCHEMA_V1];
        push_presence_uint(&mut too_many, MAX_PRESENCE_RECORDS_PER_CONNECTION + 1);
        assert!(decode_presence(&too_many, "42").is_none());
        assert!(decode_presence(&vec![0; MAX_PRESENCE_BYTES_PER_CONNECTION + 1], "42").is_none());
    }

    #[test]
    fn presence_registry_keeps_latest_state_and_makes_explicit_removal() {
        let first = presence_record("42-cm-sel", r#"{"from":1,"to":1}"#);
        let latest = presence_record("42-cm-sel", r#"{"from":9,"to":9}"#);
        let mut state = PresenceState::default();
        for bytes in [&first, &latest] {
            for (key, record) in decode_presence(bytes, "42").unwrap() {
                state.records.insert(key, record.unwrap());
            }
        }
        assert_eq!(state.records.len(), 1, "cursor history is never retained");
        let removals =
            encode_presence_changes(state.records.into_keys().map(|key| (key, None)).collect());
        let decoded = decode_presence(&removals, "42").unwrap();
        assert!(matches!(&decoded[..], [(_, None)]));
    }

    #[test]
    fn receipt_ranges_skip_sequences_already_known_sparse() {
        let site = 41;
        let mut before = Version::default();
        before.note(site, 1);
        before.note(site, 3);
        let mut after = before.clone();
        after.note(site, 2);
        after.note(site, 5);

        let ranges = new_receipt_ranges(&before, &after);
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            (ranges[0].site, ranges[0].first, ranges[0].last),
            (site, 2, 2)
        );
        assert_eq!(
            (ranges[1].site, ranges[1].first, ranges[1].last),
            (site, 5, 5)
        );
    }

    #[test]
    fn sqlite_sequence_boundary_fails_closed_without_aliasing() {
        let mut boundary = Version::default();
        boundary.note(9, MAX_STORED_SEQUENCE);
        assert!(version_fits_storage(&boundary));
        assert_eq!(store::exact_i64(MAX_STORED_SEQUENCE).unwrap(), i64::MAX);

        let mut overflow = Version::default();
        overflow.note(9, MAX_STORED_SEQUENCE + 1);
        assert!(!version_fits_storage(&overflow));
        assert!(store::exact_i64(MAX_STORED_SEQUENCE + 1).is_err());
    }
}
