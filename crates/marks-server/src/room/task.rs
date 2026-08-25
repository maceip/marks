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
    MSG_MUTATION, MSG_PRESENCE_DELTA, MSG_SERVER_VV, MSG_SNAPSHOT, MSG_SYNCED, MSG_UPDATE, OutMsg,
    PresenceCounters, RoomMsg, RoomRead, frame,
};
use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::ids::now_ms;
use crate::routes::documents::apply_public_editor_floor;
use crate::store;
use esbt::Artifact;
use esbt::ErrorCode;
use esbt::clock::Version;
use marks_auth::{
    DocumentAction, DocumentId, DocumentRole, PrincipalId, RoomActor, ScratchId, SessionId,
    authorize_room_action,
};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use tokio::sync::mpsc;

/// Presence frames are relayed, never persisted; bound them separately.
const MAX_EPHEMERAL_BYTES: usize = 1536;
const EPHEMERAL_FRAMES_PER_SECOND: f64 = 30.0;
const EPHEMERAL_BYTES_PER_SECOND: f64 = 24.0 * 1024.0;
const DURABLE_QUEUE_RESERVE: usize = 16;
const PRESENCE_TAG: u8 = 5;
const PRESENCE_VERSION: u8 = 2;
const MAX_PRESENCE_SEQUENCE: u64 = (1_u64 << 53) - 1;

/// Receipts older than this window may be recreated as duplicate CRDT commits;
/// their operations remain idempotent even after the receipt row is pruned.
const IDEMPOTENCY_RECEIPT_WINDOW: u64 = 65_536;

struct Socket {
    actor: RoomActor,
    color: u8,
    out: mpsc::Sender<OutMsg>,
    mutation_window: u64,
    mutations_in_window: u32,
    mutation_bytes_in_window: usize,

    presence_instance: Option<[u8; 16]>,
    presence_sequence: u64,
    presence_keys: HashSet<String>,
    ephemeral_frames: f64,
    ephemeral_bytes: f64,
    ephemeral_refill: std::time::Instant,
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

#[derive(Debug)]
struct PresenceEntry {
    key: String,
    deleted: bool,
    age: u64,
    value: Vec<u8>,
}

#[derive(Clone)]
struct PresenceLease {
    conn: u64,
    instance: [u8; 16],
    sequence: u64,
    keys: HashSet<String>,
}

fn presence_uint(input: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    let mut shift = 0;
    let start = *offset;
    loop {
        let byte = *input.get(*offset)?;
        *offset += 1;
        if shift >= 63 && byte & 0x7f != 0 {
            return None;
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            if *offset - start > 1 && byte == 0 {
                return None;
            }
            return Some(value);
        }
        shift += 7;
    }
}

fn presence_put_uint(out: &mut Vec<u8>, mut value: u64) {
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

fn decode_presence(input: &[u8]) -> Option<([u8; 16], u64, Vec<PresenceEntry>)> {
    if input.get(0..2)? != [PRESENCE_TAG, PRESENCE_VERSION] {
        return None;
    }
    let instance: [u8; 16] = input.get(2..18)?.try_into().ok()?;
    let mut offset = 18;
    let sequence = presence_uint(input, &mut offset)?;
    if sequence == 0 || sequence > MAX_PRESENCE_SEQUENCE {
        return None;
    }
    let count = usize::try_from(presence_uint(input, &mut offset)?).ok()?;
    if count > 256 {
        return None;
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let key_len = usize::try_from(presence_uint(input, &mut offset)?).ok()?;
        if key_len == 0 || key_len > 256 {
            return None;
        }
        let key = std::str::from_utf8(input.get(offset..offset.checked_add(key_len)?)?)
            .ok()?
            .to_owned();
        offset += key_len;
        let flags = *input.get(offset)?;
        offset += 1;
        if flags == 1 {
            entries.push(PresenceEntry {
                key,
                deleted: true,
                age: 0,
                value: vec![],
            });
            continue;
        }
        if flags != 0 {
            return None;
        }
        let age = presence_uint(input, &mut offset)?;
        let value_len = usize::try_from(presence_uint(input, &mut offset)?).ok()?;
        if value_len > 16 * 1024 {
            return None;
        }
        let value = input.get(offset..offset.checked_add(value_len)?)?.to_vec();
        offset += value_len;
        // Validate JSON now so relayed frames satisfy the client codec.
        serde_json::from_slice::<serde_json::Value>(&value).ok()?;
        entries.push(PresenceEntry {
            key,
            deleted: false,
            age,
            value,
        });
    }
    (offset == input.len()).then_some((instance, sequence, entries))
}

fn encode_presence(instance: [u8; 16], sequence: u64, entries: &[PresenceEntry]) -> Vec<u8> {
    let mut out = vec![PRESENCE_TAG, PRESENCE_VERSION];
    out.extend_from_slice(&instance);
    presence_put_uint(&mut out, sequence);
    presence_put_uint(&mut out, entries.len() as u64);
    for entry in entries {
        presence_put_uint(&mut out, entry.key.len() as u64);
        out.extend_from_slice(entry.key.as_bytes());
        out.push(u8::from(entry.deleted));
        if !entry.deleted {
            presence_put_uint(&mut out, entry.age.min(30_000));
            presence_put_uint(&mut out, entry.value.len() as u64);
            out.extend_from_slice(&entry.value);
        }
    }
    out
}

struct SeenMutation {
    kind: MutationKind,
    digest: [u8; 32],
    revision: u64,
    version: Vec<u8>,
}

type SeenMutations = HashMap<[u8; 16], SeenMutation>;

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

    retired_presence: HashSet<[u8; 16]>,
    active_presence: HashMap<String, PresenceLease>,

    next_conn: u64,
    dead: Option<u16>,
    commit_batches: Arc<AtomicU64>,
    committed_mutations: Arc<AtomicU64>,
    presence: Arc<PresenceCounters>,
    connections: Arc<AtomicUsize>,
}

pub(super) struct TaskContext {
    pub(super) document_id: DocumentId,
    pub(super) db: Arc<Db>,
    pub(super) config: Arc<Config>,
    pub(super) limits: esbt::ResourceLimits,
    pub(super) commit_batches: Arc<AtomicU64>,
    pub(super) committed_mutations: Arc<AtomicU64>,
    pub(super) presence: Arc<PresenceCounters>,
    pub(super) connections: Arc<AtomicUsize>,
}

pub(super) async fn run(
    context: TaskContext,
    mut rx: mpsc::Receiver<RoomMsg>,
    mut control_rx: mpsc::Receiver<Control>,
) {
    let TaskContext {
        document_id,
        db,
        config,
        limits,
        commit_batches,
        committed_mutations,
        presence,
        connections,
    } = context;
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

            retired_presence: HashSet::new(),
            active_presence: HashMap::new(),

            next_conn: 1,
            dead: None,
            commit_batches,
            committed_mutations,
            presence,
            connections,
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
    let mut deferred_control = None;
    let mut control_open = true;

    loop {
        let immediate_control = deferred_control.take().or_else(|| {
            if !control_open {
                return None;
            }
            match control_rx.try_recv() {
                Ok(control) => Some(control),
                Err(mpsc::error::TryRecvError::Empty) => None,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    control_open = false;
                    None
                }
            }
        });
        if let Some(control) = immediate_control {
            room.control(control);
            continue;
        }

        let receive = async {
            if let Some(message) = deferred.take() {
                return Some(Ok(message));
            }
            if control_open {
                tokio::select! {
                    biased;
                    control = control_rx.recv() => match control {
                        Some(control) => Some(Err(control)),
                        None => {
                            control_open = false;
                            rx.recv().await.map(Ok)
                        }
                    },
                    message = rx.recv() => message.map(Ok),
                }
            } else {
                rx.recv().await.map(Ok)
            }
        };
        let input = if room.sockets.is_empty() && room.dead.is_none() {
            match tokio::time::timeout(
                std::time::Duration::from_millis(room.config.room_idle_ms),
                receive,
            )
            .await
            {
                Ok(input) => input,
                Err(_) => {
                    room.compact(true);
                    return;
                }
            }
        } else {
            receive.await
        };
        let Some(input) = input else {
            break;
        };
        let message = match input {
            Ok(message) => message,
            Err(control) => {
                room.control(control);
                continue;
            }
        };
        match message {
            RoomMsg::Join {
                actor,
                client_version,
                out,
                resp,
            } => {
                if !resp.is_closed() {
                    let joined = room.join(*actor, client_version, out);
                    let admitted = joined.as_ref().ok().copied();
                    if resp.send(joined).is_err()
                        && let Some(conn) = admitted
                    {
                        room.sockets.remove(&conn);
                        room.update_connection_count();
                    }
                }
            }
            RoomMsg::Frame { conn, data } => {
                let mut frames = vec![(conn, data)];
                let deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_millis(room.config.commit_batch_delay_ms);
                while frames.len() < room.config.commit_batch_max {
                    if control_open {
                        tokio::select! {
                            biased;
                            control = control_rx.recv() => match control {
                                Some(control) => {
                                    deferred_control = Some(control);
                                    break;
                                }
                                None => control_open = false,
                            },
                            next = tokio::time::timeout_at(deadline, rx.recv()) => match next {
                                Ok(Some(RoomMsg::Frame { conn, data })) => frames.push((conn, data)),
                                Ok(Some(other)) => {
                                    deferred = Some(other);
                                    break;
                                }
                                Ok(None) | Err(_) => break,
                            },
                        }
                    } else {
                        match tokio::time::timeout_at(deadline, rx.recv()).await {
                            Ok(Some(RoomMsg::Frame { conn, data })) => frames.push((conn, data)),
                            Ok(Some(other)) => {
                                deferred = Some(other);
                                break;
                            }
                            Ok(None) | Err(_) => break,
                        }
                    }
                }
                if let Some(control) = deferred_control.take() {
                    room.control(control);
                }
                room.frames(frames);
            }
            RoomMsg::Leave { conn } => {
                room.sockets.remove(&conn);
                room.update_connection_count();
                if room.sockets.is_empty() && room.dead.is_none() {
                    room.compact(true);
                }
            }
            RoomMsg::Read { resp } => {
                if !resp.is_closed() {
                    let _ = resp.send(room.read());
                }
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
    room.connections.store(0, Ordering::Release);
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
        let identity = match &actor {
            RoomActor::Principal(a) => &a.identity,
            RoomActor::Scratch(a) => &a.identity,
        };
        let color = self
            .sockets
            .values()
            .find_map(|socket| {
                let other = match &socket.actor {
                    RoomActor::Principal(a) => &a.identity,
                    RoomActor::Scratch(a) => &a.identity,
                };
                (other.participant_id == identity.participant_id).then_some(socket.color)
            })
            .unwrap_or_else(|| {
                let used: std::collections::HashSet<u8> =
                    self.sockets.values().map(|socket| socket.color).collect();
                let preferred = identity.preferred_color.clamp(1, 8);
                (0..8)
                    .map(|offset| (preferred - 1 + offset) % 8 + 1)
                    .find(|candidate| !used.contains(candidate))
                    .unwrap_or(preferred)
            });
        self.sockets.insert(
            conn,
            Socket {
                actor,
                color,
                out,
                mutation_window: now_ms() / 1_000,
                mutations_in_window: 0,
                mutation_bytes_in_window: 0,

                presence_instance: None,
                presence_sequence: 0,
                presence_keys: HashSet::new(),
                ephemeral_frames: EPHEMERAL_FRAMES_PER_SECOND,
                ephemeral_bytes: EPHEMERAL_BYTES_PER_SECOND,
                ephemeral_refill: std::time::Instant::now(),
            },
        );
        self.update_connection_count();
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
                // direct write was saved.
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
                let update = match Artifact::decode_with_limits(mutation.payload, &self.limits) {
                    Ok(Artifact::Update(update))
                        if update.operations().iter().all(|operation| {
                            operation.origin == actor.site && sequence_fits_storage(operation.seq)
                        }) =>
                    {
                        update
                    }
                    Ok(Artifact::Update(_)) | Ok(_) | Err(_) => {
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
                    match Artifact::decode_with_limits(mutation.payload, &self.limits) {
                        Ok(Artifact::CompactSnapshot(snapshot)) => snapshot.version,
                        Ok(Artifact::FullSnapshot(snapshot)) => snapshot.state.version,
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
        let anonymous_edits = prepared
            .iter()
            .filter(|commit| {
                commit.actor.kind == "scratch" && !matches!(commit.action, CommitAction::Receipt)
            })
            .count() as u64;
        let anonymous_persisted_at = prepared
            .iter()
            .filter(|commit| {
                commit.actor.kind == "scratch" && !matches!(commit.action, CommitAction::Receipt)
            })
            .map(|commit| commit.committed_at)
            .max()
            .unwrap_or_default();
        let authority_checked_at = now_ms();
        let committed: ApiResult<()> = self.db.tx(|db| {
            require_live_epoch(db, &document_id, epoch)?;
            let mut validated_actors = HashSet::new();
            for commit in &prepared {
                let actor_key = (
                    commit.actor.kind,
                    commit.actor.id.as_str(),
                    commit.actor.session_id.as_deref(),
                );
                if validated_actors.insert(actor_key) {
                    require_live_actor(db, &commit.actor, authority_checked_at)?;
                }
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
            if anonymous_edits > 0 {
                db.execute(
                    "UPDATE documents
                     SET anonymous_edit_count = anonymous_edit_count + ?2,
                         persisted_at = CASE
                           WHEN persisted_at IS NULL
                            AND anonymous_edit_count + ?2 > 6 THEN ?3
                           ELSE persisted_at
                         END
                     WHERE id = ?1 AND public_edit = 1",
                    params![
                        document_id.as_str(),
                        store::ms(anonymous_edits),
                        store::ms(anonymous_persisted_at),
                    ],
                )?;
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
        self.presence.received.fetch_add(1, Ordering::Relaxed);
        let Some(socket) = self.sockets.get_mut(&conn) else {
            return;
        };
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(socket.ephemeral_refill).as_secs_f64();
        socket.ephemeral_refill = now;
        socket.ephemeral_frames = (socket.ephemeral_frames + elapsed * EPHEMERAL_FRAMES_PER_SECOND)
            .min(EPHEMERAL_FRAMES_PER_SECOND);
        socket.ephemeral_bytes = (socket.ephemeral_bytes + elapsed * EPHEMERAL_BYTES_PER_SECOND)
            .min(EPHEMERAL_BYTES_PER_SECOND);
        if payload.len() > MAX_EPHEMERAL_BYTES
            || socket.ephemeral_frames < 1.0
            || socket.ephemeral_bytes < payload.len() as f64
        {
            self.presence.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        socket.ephemeral_frames -= 1.0;
        socket.ephemeral_bytes -= payload.len() as f64;
        let Some(socket) = self.sockets.get(&conn) else {
            return;
        };
        if !authorize_room_action(&socket.actor, DocumentAction::PublishPresence) {
            return;
        }

        let (owner, identity) = match &socket.actor {
            RoomActor::Principal(actor) => (actor.esbt_site.to_string(), actor.identity.clone()),
            RoomActor::Scratch(actor) => (actor.esbt_site.to_string(), actor.identity.clone()),
        };
        let color = socket.color;
        let Some((instance, sequence, mut entries)) = decode_presence(payload) else {
            return;
        };
        // The terminal sequence is reserved for the room-generated retirement
        // tombstone, so even a hostile sender cannot make retirement lose.
        if sequence == MAX_PRESENCE_SEQUENCE {
            return;
        }
        if self.retired_presence.contains(&instance) {
            return;
        }

        let bound = socket.presence_instance;
        if bound.is_some_and(|bound| bound != instance) || sequence <= socket.presence_sequence {
            return;
        }

        // Only the admitted actor owns `<site>-cm-*`; never relay an identity
        // chosen by the client. Unknown key namespaces are rejected.
        for entry in &mut entries {
            let Some((_, suffix)) = entry.key.split_once("-cm-") else {
                return;
            };
            if suffix.is_empty() {
                return;
            }
            let suffix = suffix.to_owned();
            entry.key = format!("{owner}-cm-{suffix}");
            if suffix == "user" && !entry.deleted {
                let mut user = serde_json::Map::new();
                user.insert(
                    "participantId".into(),
                    identity.participant_id.clone().into(),
                );
                user.insert("connectionId".into(), conn.to_string().into());
                user.insert("name".into(), identity.display_name.clone().into());
                user.insert("colorIndex".into(), color.into());
                if let Some(avatar) = &identity.avatar {
                    user.insert("avatar".into(), avatar.clone().into());
                }
                entry.value =
                    serde_json::to_vec(&serde_json::Value::Object(user)).unwrap_or_default();
            }
        }

        if bound.is_none() {
            // A reconnect using the same durable site first retires the old
            // socket instance. Its terminal tombstone wins over every update.
            let old = self
                .active_presence
                .get(&owner)
                .cloned()
                .filter(|lease| lease.instance != instance);
            if let Some(PresenceLease {
                conn: other,
                instance: old_instance,
                sequence: old_sequence,
                keys,
            }) = old
            {
                self.retired_presence.insert(old_instance);
                let removals: Vec<_> = keys
                    .into_iter()
                    .map(|key| PresenceEntry {
                        key,
                        deleted: true,
                        age: 0,
                        value: vec![],
                    })
                    .collect();
                let retired = encode_presence(old_instance, old_sequence + 1, &removals);
                self.broadcast(other, frame(MSG_EPHEMERAL, &retired));
                if let Some(socket) = self.sockets.get_mut(&other) {
                    socket.presence_instance = None;
                    socket.presence_keys.clear();
                }
            }
        }

        let canonical = encode_presence(instance, sequence, &entries);
        if canonical.len() > MAX_EPHEMERAL_BYTES {
            return;
        }
        if let Some(socket) = self.sockets.get_mut(&conn) {
            socket.presence_instance = Some(instance);
            socket.presence_sequence = sequence;
            for entry in &entries {
                if entry.deleted {
                    socket.presence_keys.remove(&entry.key);
                } else {
                    socket.presence_keys.insert(entry.key.clone());
                }
            }
            self.active_presence.insert(
                owner,
                PresenceLease {
                    conn,
                    instance,
                    sequence,
                    keys: socket.presence_keys.clone(),
                },
            );
        }
        self.broadcast_ephemeral(conn, frame(MSG_EPHEMERAL, &canonical));
    }

    fn broadcast_ephemeral(&mut self, from: u64, message: Vec<u8>) {
        self.presence.broadcast.fetch_add(1, Ordering::Relaxed);
        for (&conn, socket) in &self.sockets {
            if conn != from
                && (socket.out.capacity() <= DURABLE_QUEUE_RESERVE
                    || socket.out.try_send(OutMsg::Frame(message.clone())).is_err())
            {
                self.presence.coalesced.fetch_add(1, Ordering::Relaxed);
            }
        }
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
                            .map(|role| apply_public_editor_floor(role, row.public_edit))
                            .or_else(|| row.public_edit.then_some(DocumentRole::Editor))
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
                        (live && (owns || row.public_edit)).then(|| {
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
            self.update_connection_count();
        }
    }

    fn close_all(&mut self, code: u16) {
        let conns: Vec<u64> = self.sockets.keys().copied().collect();
        for conn in conns {
            self.close_one(conn, code);
        }
    }

    fn update_connection_count(&self) {
        self.connections
            .store(self.sockets.len(), Ordering::Release);
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

/// Controls close live sockets promptly, but durable authority never depends
/// on delivery of an in-memory signal. Re-check the admitted actor in the same
/// SQLite transaction that appends its mutation.
fn require_live_actor(db: &rusqlite::Connection, actor: &ActorReceipt, now: u64) -> ApiResult<()> {
    match actor.kind {
        "scratch" => {
            let scratch_id = ScratchId::new(actor.id.clone()).map_err(|_| ApiError::conflict())?;
            store::load_scratch(db, &scratch_id)?
                .filter(|scratch| {
                    scratch.revoked_at_ms.is_none()
                        && scratch.claimed_by.is_none()
                        && now < scratch.expires_at_ms
                })
                .ok_or_else(ApiError::conflict)?;
            if actor.session_id.is_some() {
                return Err(ApiError::conflict());
            }
        }
        "principal" => {
            let principal_id =
                PrincipalId::new(actor.id.clone()).map_err(|_| ApiError::conflict())?;
            let session_id = actor
                .session_id
                .as_ref()
                .ok_or_else(ApiError::conflict)
                .and_then(|id| SessionId::new(id.clone()).map_err(|_| ApiError::conflict()))?;
            let session = store::load_session(db, &session_id)?
                .filter(|session| {
                    session.record.revoked_at_ms.is_none()
                        && now < session.record.expires_at_ms
                        && session.record.principal_id == principal_id
                })
                .ok_or_else(ApiError::conflict)?;
            let device_id = session.record.device_id.clone();
            store::load_device(db, &device_id)?
                .filter(|device| {
                    device.revoked_at_ms.is_none()
                        && device.principal_id == principal_id
                        && device.id == session.record.device_id
                })
                .ok_or_else(ApiError::conflict)?;
            let principal =
                store::load_principal(db, &principal_id)?.ok_or_else(ApiError::conflict)?;
            marks_auth::require_active_principal(&principal).map_err(|_| ApiError::conflict())?;
        }
        _ => return Err(ApiError::conflict()),
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
    Artifact::classify(payload).is_ok_and(|kind| {
        matches!(
            kind,
            esbt::ArtifactKind::CompactSnapshot | esbt::ArtifactKind::FullSnapshot
        )
    })
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
