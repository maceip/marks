use crate::error::{ApiError, ApiResult};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// One WAL database with a serialized FULL-synchronous writer and an
/// independent read connection. Blocking rusqlite work is declared to Tokio so
/// an fsync or busy wait does not pin an async worker thread.
pub struct Db {
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> ApiResult<Self> {
        static NEXT_MEMORY_DB: AtomicU64 = AtomicU64::new(1);
        let (writer, reader) = if path.as_os_str() == ":memory:" {
            let uri = format!(
                "file:marks-memory-{}?mode=memory&cache=shared",
                NEXT_MEMORY_DB.fetch_add(1, Ordering::Relaxed)
            );
            let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI;
            (
                Connection::open_with_flags(&uri, flags)?,
                Connection::open_with_flags(&uri, flags)?,
            )
        } else {
            (Connection::open(path)?, Connection::open(path)?)
        };
        configure(&writer, true)?;
        configure(&reader, false)?;
        let db = Self {
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Run read-only work on the connection.
    pub fn read<T>(&self, work: impl FnOnce(&Connection) -> ApiResult<T>) -> ApiResult<T> {
        run_blocking(|| {
            let conn = self.reader.lock().map_err(|_| ApiError::internal())?;
            work(&conn)
        })
    }

    /// Run one immediate transaction. The closure either commits atomically
    /// or everything rolls back; validators never pair with unguarded writes.
    pub fn tx<T>(&self, work: impl FnOnce(&Connection) -> ApiResult<T>) -> ApiResult<T> {
        run_blocking(|| {
            let mut conn = self.writer.lock().map_err(|_| ApiError::internal())?;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            match work(&tx) {
                Ok(value) => {
                    tx.commit()?;
                    Ok(value)
                }
                Err(error) => {
                    drop(tx);
                    Err(error)
                }
            }
        })
    }

    /// SQLite's online backup API produces one transactionally valid main DB
    /// without copying WAL/SHM files or requiring the service to stop.
    pub fn backup_to(&self, destination: &Path) -> ApiResult<()> {
        run_blocking(|| {
            let source = self.writer.lock().map_err(|_| ApiError::internal())?;
            let mut target = Connection::open(destination)?;
            configure(&target, true)?;
            let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
            backup.run_to_completion(128, Duration::from_millis(1), None)?;
            drop(backup);
            let integrity: String =
                target.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
            if integrity != "ok" {
                return Err(ApiError::internal());
            }
            target.pragma_update(None, "journal_mode", "DELETE")?;
            Ok(())
        })
    }

    fn migrate(&self) -> ApiResult<()> {
        let mut conn = self.writer.lock().map_err(|_| ApiError::internal())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
             );",
        )?;
        let applied: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        // Fail closed instead of silently serving a schema this binary has
        // never seen: without this, rolling back past a migration would run
        // old code against new tables and corrupt instead of refusing.
        if applied > schema_version() {
            return Err(ApiError::unavailable(
                "database schema is newer than this binary supports",
            ));
        }
        for (version, sql) in MIGRATIONS {
            if *version <= applied {
                continue;
            }
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![version, crate::ids::now_ms() as i64],
            )?;
            tx.commit()?;
        }
        Ok(())
    }
}

fn configure(connection: &Connection, writer: bool) -> ApiResult<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", if writer { "FULL" } else { "NORMAL" })?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn run_blocking<T>(work: impl FnOnce() -> T) -> T {
    if tokio::runtime::Handle::try_current()
        .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
    {
        tokio::task::block_in_place(work)
    } else {
        work()
    }
}

/// The schema this binary migrates a database to, which is also the newest
/// schema it can safely serve. Release receipts record it so rollback
/// tooling can compare a candidate binary against the live database before
/// switching releases.
pub fn schema_version() -> i64 {
    MIGRATIONS.last().map(|(version, _)| *version).unwrap_or(0)
}

/// Ordered, transactional migrations. Constraints here are protocol
/// requirements from `docs/AUTHN-AUTHZ-PROTOCOL.md` §9, not implementation
/// convenience.
const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "
    CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        disabled_at INTEGER
    );

    CREATE TABLE scratch_workspaces (
        id TEXT PRIMARY KEY,
        capability_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_by TEXT REFERENCES principals(id),
        claimed_at INTEGER,
        finalize_expires_at INTEGER,
        revoked_at INTEGER
    );

    CREATE TABLE pending_devices (
        id TEXT PRIMARY KEY,
        scratch_id TEXT NOT NULL UNIQUE REFERENCES scratch_workspaces(id),
        public_key_sec1 BLOB NOT NULL,
        public_key_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        public_key_sec1 BLOB NOT NULL,
        key_epoch INTEGER NOT NULL,
        capability_bits INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
    );

    CREATE TABLE controllers (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        key_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(principal_id, device_id)
    );

    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        secret_hash BLOB NOT NULL,
        prev_secret_hash BLOB,
        rotated_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
    );
    CREATE INDEX sessions_by_device ON sessions(device_id);
    CREATE INDEX sessions_by_principal ON sessions(principal_id);

    CREATE TABLE pairings (
        id TEXT PRIMARY KEY,
        scratch_id TEXT NOT NULL REFERENCES scratch_workspaces(id),
        pending_device_id TEXT NOT NULL REFERENCES pending_devices(id),
        pending_device_public_key_hash BLOB NOT NULL,
        secret_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        approved_principal_id TEXT REFERENCES principals(id)
    );

    CREATE TABLE auth_challenges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        device_id TEXT,
        scratch_id TEXT,
        bound_device_id TEXT,
        bound_public_key_hash BLOB,
        nonce_hash BLOB NOT NULL,
        audience TEXT NOT NULL,
        adapter_version TEXT,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
    );

    CREATE TABLE verified_email_locators (
        locator_key_version INTEGER NOT NULL,
        locator BLOB NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        issuer_policy_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY(locator_key_version, locator)
    );

    CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        scratch_id TEXT REFERENCES scratch_workspaces(id),
        owner_principal_id TEXT REFERENCES principals(id),
        title TEXT NOT NULL,
        title_explicit INTEGER NOT NULL DEFAULT 0,
        engine TEXT NOT NULL DEFAULT 'esbt',
        chars INTEGER NOT NULL DEFAULT 0,
        auth_epoch INTEGER NOT NULL DEFAULT 1,
        snapshot BLOB,
        snapshot_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        CHECK ((scratch_id IS NULL) <> (owner_principal_id IS NULL))
    );
    CREATE INDEX documents_by_scratch ON documents(scratch_id);
    CREATE INDEX documents_by_owner ON documents(owner_principal_id);

    CREATE TABLE document_acl (
        document_id TEXT NOT NULL REFERENCES documents(id),
        principal_id TEXT NOT NULL REFERENCES principals(id),
        role TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(document_id, principal_id)
    );

    CREATE TABLE link_grants (
        document_id TEXT NOT NULL REFERENCES documents(id),
        token_hash BLOB NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(document_id, token_hash)
    );

    CREATE TABLE document_sites (
        document_id TEXT NOT NULL REFERENCES documents(id),
        site_id INTEGER NOT NULL,
        authority_kind TEXT NOT NULL,
        scratch_id TEXT,
        principal_id TEXT,
        device_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(document_id, site_id)
    );

    CREATE TABLE document_tickets (
        id TEXT PRIMARY KEY,
        secret_hash BLOB NOT NULL,
        authority_kind TEXT NOT NULL,
        scratch_id TEXT,
        principal_id TEXT,
        session_id TEXT,
        device_id TEXT,
        document_id TEXT NOT NULL REFERENCES documents(id),
        site_id INTEGER NOT NULL,
        role TEXT,
        auth_epoch INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        revoked_at INTEGER,
        CHECK (
            (authority_kind = 'scratch' AND scratch_id IS NOT NULL
                AND principal_id IS NULL AND session_id IS NULL
                AND device_id IS NULL AND role IS NULL)
            OR
            (authority_kind = 'principal' AND scratch_id IS NULL
                AND principal_id IS NOT NULL AND session_id IS NOT NULL
                AND device_id IS NOT NULL AND role IS NOT NULL)
        )
    );

    CREATE TABLE document_updates (
        document_id TEXT NOT NULL REFERENCES documents(id),
        revision INTEGER NOT NULL,
        payload BLOB NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        received_at INTEGER NOT NULL,
        PRIMARY KEY(document_id, revision)
    );

    CREATE TABLE op_authors (
        document_id TEXT NOT NULL,
        site TEXT NOT NULL,
        seq INTEGER NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        received_at INTEGER NOT NULL,
        PRIMARY KEY(document_id, site, seq)
    );
    ",
    ),
    (
        2,
        "
    -- Device challenges snapshot the enrolled key epoch at mint time so a
    -- rotation between challenge and proof cannot mint a session.
    ALTER TABLE auth_challenges ADD COLUMN key_epoch INTEGER;
    ",
    ),
    (
        3,
        "
    -- Four-word accessibility code for camera-less pairing. Only the
    -- domain-separated digest is stored; the words never persist.
    ALTER TABLE pairings ADD COLUMN word_code_hash BLOB;
    CREATE UNIQUE INDEX pairings_word_code_hash
        ON pairings(word_code_hash)
        WHERE word_code_hash IS NOT NULL;
    ",
    ),
    (
        4,
        "
    -- A client mutation is acknowledged only after this receipt and its
    -- document state commit atomically. Retrying the same id is therefore a
    -- read of the original commit, not a second write.
    CREATE TABLE document_commits (
        document_id TEXT NOT NULL REFERENCES documents(id),
        message_id BLOB NOT NULL CHECK(length(message_id) = 16),
        payload_hash BLOB NOT NULL CHECK(length(payload_hash) = 32),
        kind INTEGER NOT NULL CHECK(kind IN (1, 2)),
        revision INTEGER NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY(document_id, message_id)
    );
    CREATE INDEX document_commits_by_revision
        ON document_commits(document_id, revision);
    ",
    ),
    (
        5,
        "
    -- Health polling never writes. This single row is instead updated by the
    -- process heartbeat through the same durable writer as document commits.
    CREATE TABLE server_health (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        checked_at INTEGER NOT NULL
    );
    INSERT INTO server_health(singleton, checked_at) VALUES (1, 0);
    ",
    ),
    (
        6,
        "
    -- Comments and named versions are product metadata, not CRDT operations.
    -- Versions store compressed canonical Markdown behind a content hash so
    -- repeated labels on identical content do not duplicate large blobs and
    -- remain portable across future engine versions.
    CREATE TABLE document_comments (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        author_principal_id TEXT NOT NULL REFERENCES principals(id),
        body TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0, 1)),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by_principal_id TEXT REFERENCES principals(id)
    );
    CREATE INDEX document_comments_by_document
        ON document_comments(document_id, created_at DESC);

    CREATE TABLE document_version_blobs (
        document_id TEXT NOT NULL REFERENCES documents(id),
        content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
        markdown_zstd BLOB NOT NULL,
        markdown_bytes INTEGER NOT NULL,
        chars INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(document_id, content_hash)
    );

    CREATE TABLE document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        content_hash BLOB NOT NULL,
        label TEXT NOT NULL,
        author_principal_id TEXT NOT NULL REFERENCES principals(id),
        created_at INTEGER NOT NULL,
        FOREIGN KEY(document_id, content_hash)
            REFERENCES document_version_blobs(document_id, content_hash)
    );
    CREATE INDEX document_versions_by_document
        ON document_versions(document_id, created_at DESC);
    ",
    ),
    (
        7,
        "
    -- A recovery snapshot can admit a long contiguous prefix without carrying
    -- one retained operation object per receipt. Attribute those receipts as
    -- bounded ranges instead of expanding attacker-controlled sequence spans.
    CREATE TABLE op_author_ranges (
        document_id TEXT NOT NULL REFERENCES documents(id),
        site TEXT NOT NULL,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        received_at INTEGER NOT NULL,
        CHECK(first_seq > 0 AND last_seq >= first_seq),
        PRIMARY KEY(document_id, site, first_seq, last_seq)
    );
    CREATE INDEX op_author_ranges_lookup
        ON op_author_ranges(document_id, site, first_seq, last_seq);
    ",
    ),
    (
        8,
        "
    -- Review threads retain ESBT-owned range anchors but remain product
    -- metadata. Root messages and replies are soft-deleted so a deletion does
    -- not erase the surrounding conversation or leave dangling UI state.
    ALTER TABLE document_comments ADD COLUMN start_anchor BLOB;
    ALTER TABLE document_comments ADD COLUMN end_anchor BLOB;
    ALTER TABLE document_comments ADD COLUMN quote TEXT NOT NULL DEFAULT '';
    ALTER TABLE document_comments ADD COLUMN start_offset INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE document_comments ADD COLUMN end_offset INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE document_comments ADD COLUMN edited_at INTEGER;
    ALTER TABLE document_comments ADD COLUMN deleted_at INTEGER;

    CREATE TABLE document_comment_replies (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES document_comments(id),
        author_principal_id TEXT NOT NULL REFERENCES principals(id),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER
    );
    CREATE INDEX document_comment_replies_by_thread
        ON document_comment_replies(comment_id, created_at ASC);
    ",
    ),
    (
        9,
        "
    -- Binary bytes live in the content-addressed filesystem store; SQLite
    -- owns the authorization/reference graph and exact quotas.
    CREATE TABLE asset_blobs (
        content_hash BLOB PRIMARY KEY CHECK(length(content_hash) = 32),
        bytes INTEGER NOT NULL CHECK(bytes > 0),
        media_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE document_assets (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        content_hash BLOB NOT NULL REFERENCES asset_blobs(content_hash),
        filename TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(document_id, content_hash)
    );
    CREATE INDEX document_assets_by_document
        ON document_assets(document_id, created_at ASC);
    ",
    ),
    (
        10,
        "
    -- Agent runs are session-owned, document-authorized, and exactly
    -- idempotent. Events are a bounded semantic journal so an SSE reconnect
    -- and a process restart can replay the same terminal receipt.
    CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        principal_id TEXT NOT NULL REFERENCES principals(id),
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_hash BLOB NOT NULL CHECK(length(request_hash) = 32),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
            'queued', 'running', 'waiting_for_tool',
            'completed', 'failed', 'cancelled'
        )),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        terminal_code TEXT,
        output_text TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, request_id)
    );
    CREATE INDEX agent_runs_by_session
        ON agent_runs(session_id, created_at DESC);
    CREATE INDEX agent_runs_by_expiry
        ON agent_runs(expires_at);

    CREATE TABLE agent_events (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, sequence)
    );

    CREATE TABLE agent_tool_receipts (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash BLOB NOT NULL CHECK(length(request_hash) = 32),
        status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'cancelled')),
        output_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, call_id),
        UNIQUE(run_id, request_id)
    );

    CREATE TABLE agent_usage_daily (
        principal_id TEXT NOT NULL REFERENCES principals(id),
        day INTEGER NOT NULL,
        run_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(principal_id, day)
    );
    ",
    ),
    (
        11,
        "
    -- Device Bound Session Credentials: the browser-registered hardware key
    -- and the digest of the short-lived bound cookie. Sessions without these
    -- columns are ordinary cookie sessions; DBSC is additive.
    ALTER TABLE sessions ADD COLUMN dbsc_public_key_sec1 BLOB;
    ALTER TABLE sessions ADD COLUMN dbsc_bound_at INTEGER;
    ALTER TABLE sessions ADD COLUMN dbsc_refreshed_at INTEGER;
    ALTER TABLE sessions ADD COLUMN dbsc_cookie_hash BLOB;
    -- DBSC registration/refresh challenges bind to the session they protect.
    ALTER TABLE auth_challenges ADD COLUMN session_id TEXT;
    ",
    ),
    (
        12,
        "
    -- Anonymous pages use their opaque document id as a public collaboration
    -- slug. Every mutation is already journaled durably; these columns make
    -- the default grant and the seventh-edit persistence milestone explicit.
    ALTER TABLE documents ADD COLUMN public_edit INTEGER NOT NULL DEFAULT 0
        CHECK(public_edit IN (0, 1));
    ALTER TABLE documents ADD COLUMN anonymous_edit_count INTEGER NOT NULL DEFAULT 0
        CHECK(anonymous_edit_count >= 0);
    ALTER TABLE documents ADD COLUMN persisted_at INTEGER;

    -- Preserve the intended behavior for pre-migration anonymous pages.
    -- Promotion rewrites both documents.scratch_id and scratch-owned site
    -- rows, so retained authorship/commit/asset provenance is the durable
    -- historical signal for an already-claimed anonymous page.
    UPDATE documents
       SET public_edit = 1
     WHERE scratch_id IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM document_sites s
             WHERE s.document_id = documents.id
               AND s.authority_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM document_commits c
             WHERE c.document_id = documents.id
               AND c.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM document_updates u
             WHERE u.document_id = documents.id
               AND u.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM op_authors a
             WHERE a.document_id = documents.id
               AND a.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM op_author_ranges r
             WHERE r.document_id = documents.id
               AND r.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM document_assets a
             WHERE a.document_id = documents.id
               AND a.actor_kind = 'scratch'
        );

    -- A real mutation is the first receipt row written for its document
    -- revision; later rows at that revision are idempotent/no-op receipts.
    -- This reconstructs the anonymous mutation count without counting retries.
    UPDATE documents
       SET anonymous_edit_count = MAX(
            anonymous_edit_count,
            (
                SELECT COUNT(*)
                  FROM document_commits c
                 WHERE c.document_id = documents.id
                   AND c.revision > 0
                   AND c.actor_kind = 'scratch'
                   AND c.rowid = (
                        SELECT MIN(first_commit.rowid)
                          FROM document_commits first_commit
                         WHERE first_commit.document_id = c.document_id
                           AND first_commit.revision = c.revision
                   )
            )
       )
     WHERE public_edit = 1;

    UPDATE documents
       SET persisted_at = COALESCE(
            (
                SELECT c.committed_at
                  FROM document_commits c
                 WHERE c.document_id = documents.id
                   AND c.revision > 0
                   AND c.actor_kind = 'scratch'
                   AND c.rowid = (
                        SELECT MIN(first_commit.rowid)
                          FROM document_commits first_commit
                         WHERE first_commit.document_id = c.document_id
                           AND first_commit.revision = c.revision
                   )
                 ORDER BY c.revision
                 LIMIT 1 OFFSET 6
            ),
            updated_at
       )
     WHERE public_edit = 1
       AND persisted_at IS NULL
       AND anonymous_edit_count > 6;
    ",
    ),
    (
        13,
        "
    -- Correct databases that may already have recorded migration 12 before
    -- its historical backfill learned about promotion-rewritten provenance.
    -- The MAX/COALESCE assignments are idempotent for databases on which the
    -- complete migration-12 backfill already ran.
    UPDATE documents
       SET public_edit = 1
     WHERE scratch_id IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM document_sites s
             WHERE s.document_id = documents.id
               AND s.authority_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM document_commits c
             WHERE c.document_id = documents.id
               AND c.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM document_updates u
             WHERE u.document_id = documents.id
               AND u.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM op_authors a
             WHERE a.document_id = documents.id
               AND a.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM op_author_ranges r
             WHERE r.document_id = documents.id
               AND r.actor_kind = 'scratch'
        )
        OR EXISTS (
            SELECT 1 FROM document_assets a
             WHERE a.document_id = documents.id
               AND a.actor_kind = 'scratch'
        );

    UPDATE documents
       SET anonymous_edit_count = MAX(
            anonymous_edit_count,
            (
                SELECT COUNT(*)
                  FROM document_commits c
                 WHERE c.document_id = documents.id
                   AND c.revision > 0
                   AND c.actor_kind = 'scratch'
                   AND c.rowid = (
                        SELECT MIN(first_commit.rowid)
                          FROM document_commits first_commit
                         WHERE first_commit.document_id = c.document_id
                           AND first_commit.revision = c.revision
                   )
            )
       )
     WHERE public_edit = 1;

    UPDATE documents
       SET persisted_at = COALESCE(
            (
                SELECT c.committed_at
                  FROM document_commits c
                 WHERE c.document_id = documents.id
                   AND c.revision > 0
                   AND c.actor_kind = 'scratch'
                   AND c.rowid = (
                        SELECT MIN(first_commit.rowid)
                          FROM document_commits first_commit
                         WHERE first_commit.document_id = c.document_id
                           AND first_commit.revision = c.revision
                   )
                 ORDER BY c.revision
                 LIMIT 1 OFFSET 6
            ),
            updated_at
       )
     WHERE public_edit = 1
       AND persisted_at IS NULL
       AND anonymous_edit_count > 6;
    ",
    ),
    (
        14,
        "
    -- Document creation is an atomic, authority-scoped idempotent operation.
    -- A browser keeps one request id across reload until it receives the
    -- committed slug, so a lost response cannot publish a second starter.
    ALTER TABLE documents ADD COLUMN create_request_id TEXT;
    ALTER TABLE documents ADD COLUMN create_request_hash BLOB
        CHECK(create_request_hash IS NULL OR length(create_request_hash) = 32);
    CREATE UNIQUE INDEX documents_create_request_by_scratch
        ON documents(scratch_id, create_request_id)
        WHERE scratch_id IS NOT NULL AND create_request_id IS NOT NULL;
    CREATE UNIQUE INDEX documents_create_request_by_owner
        ON documents(owner_principal_id, create_request_id)
        WHERE owner_principal_id IS NOT NULL AND create_request_id IS NOT NULL;
    ",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "marks-{name}-{}-{}.db3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn remove_db(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(path.with_extension(format!("db3{suffix}")));
        }
    }

    fn open_through(path: &Path, newest: i64) -> Connection {
        let mut connection = Connection::open(path).expect("open fixture database");
        configure(&connection, true).expect("configure fixture database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                 );",
            )
            .expect("create fixture migration table");
        for (version, sql) in MIGRATIONS {
            if *version > newest {
                break;
            }
            let tx = connection
                .transaction()
                .expect("fixture migration transaction");
            tx.execute_batch(sql).expect("apply fixture migration");
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![version, version * 1_000],
            )
            .expect("record fixture migration");
            tx.commit().expect("commit fixture migration");
        }
        connection
    }

    fn insert_anonymous_history(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO principals (id, created_at) VALUES ('principal_migrated', 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO scratch_workspaces
                    (id, capability_hash, expires_at, claimed_by, claimed_at)
                 VALUES ('scratch_claimed', zeroblob(32), 999999, 'principal_migrated', 50)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO scratch_workspaces (id, capability_hash, expires_at)
                 VALUES ('scratch_unclaimed', zeroblob(32), 999999)",
                [],
            )
            .unwrap();
        for (id, scratch, owner) in [
            (
                "document_claimed_anonymous",
                None,
                Some("principal_migrated"),
            ),
            (
                "document_seeded_anonymous",
                None,
                Some("principal_migrated"),
            ),
            (
                "document_unclaimed_anonymous",
                Some("scratch_unclaimed"),
                None,
            ),
            (
                "document_native_principal",
                None,
                Some("principal_migrated"),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO documents
                        (id, scratch_id, owner_principal_id, title, title_explicit, engine, chars,
                         auth_epoch, snapshot_revision, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?1, 1, 'esbt', 0, 1, 0, 10, 20)",
                    rusqlite::params![id, scratch, owner],
                )
                .unwrap();
        }
        // Claiming rewrote this formerly scratch-owned site, so migration 12's
        // original site predicate could not recognize the page afterwards.
        connection
            .execute(
                "INSERT INTO document_sites
                    (document_id, site_id, authority_kind, principal_id, created_at)
                 VALUES ('document_claimed_anonymous', 1, 'principal', 'principal_migrated', 10)",
                [],
            )
            .unwrap();
        // Atomic Markdown seeding leaves durable scratch authorship even when
        // the page was claimed before it opened a room.
        connection
            .execute(
                "INSERT INTO op_authors
                    (document_id, site, seq, actor_kind, actor_id, received_at)
                 VALUES ('document_seeded_anonymous', '0', 1, 'scratch', 'scratch_claimed', 20)",
                [],
            )
            .unwrap();

        for (document, actor_kind, actor_id) in [
            ("document_claimed_anonymous", "scratch", "scratch_claimed"),
            (
                "document_unclaimed_anonymous",
                "scratch",
                "scratch_unclaimed",
            ),
            (
                "document_native_principal",
                "principal",
                "principal_migrated",
            ),
        ] {
            for revision in 1_i64..=7 {
                connection
                    .execute(
                        "INSERT INTO document_commits
                            (document_id, message_id, payload_hash, kind, revision, actor_kind,
                             actor_id, committed_at)
                         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)",
                        rusqlite::params![
                            document,
                            vec![revision as u8; 16],
                            vec![revision as u8; 32],
                            revision,
                            actor_kind,
                            actor_id,
                            100 + revision,
                        ],
                    )
                    .unwrap();
            }
        }
        // Later receipts at an existing revision are not additional edits.
        connection
            .execute(
                "INSERT INTO document_commits
                    (document_id, message_id, payload_hash, kind, revision, actor_kind,
                     actor_id, committed_at)
                 VALUES ('document_claimed_anonymous', ?1, ?2, 1, 7, 'scratch',
                         'scratch_claimed', 108)",
                rusqlite::params![vec![88_u8; 16], vec![88_u8; 32]],
            )
            .unwrap();
        // Nor does a scratch no-op receipt at a principal-authored revision.
        connection
            .execute(
                "INSERT INTO document_commits
                    (document_id, message_id, payload_hash, kind, revision, actor_kind,
                     actor_id, committed_at)
                 VALUES ('document_claimed_anonymous', ?1, ?2, 1, 8, 'principal',
                         'principal_migrated', 109)",
                rusqlite::params![vec![89_u8; 16], vec![89_u8; 32]],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO document_commits
                    (document_id, message_id, payload_hash, kind, revision, actor_kind,
                     actor_id, committed_at)
                 VALUES ('document_claimed_anonymous', ?1, ?2, 1, 8, 'scratch',
                         'scratch_claimed', 110)",
                rusqlite::params![vec![90_u8; 16], vec![90_u8; 32]],
            )
            .unwrap();
    }

    fn assert_anonymous_history_backfilled(db: &Db) {
        db.read(|connection| {
            for id in ["document_claimed_anonymous", "document_unclaimed_anonymous"] {
                let row: (i64, i64, Option<i64>) = connection.query_row(
                    "SELECT public_edit, anonymous_edit_count, persisted_at
                     FROM documents WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(row, (1, 7, Some(107)), "incorrect backfill for {id}");
            }
            let seeded: (i64, i64, Option<i64>) = connection.query_row(
                "SELECT public_edit, anonymous_edit_count, persisted_at
                 FROM documents WHERE id = 'document_seeded_anonymous'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(seeded, (1, 0, None));
            let native: (i64, i64, Option<i64>) = connection.query_row(
                "SELECT public_edit, anonymous_edit_count, persisted_at
                 FROM documents WHERE id = 'document_native_principal'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(native, (0, 0, None));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn anonymous_history_is_preserved_when_schema_11_upgrades() {
        let path = temp_path("anonymous-migration-11");
        let connection = open_through(&path, 11);
        insert_anonymous_history(&connection);
        drop(connection);

        let db = Db::open(&path).expect("upgrade anonymous history");
        assert_anonymous_history_backfilled(&db);
        drop(db);
        remove_db(&path);
    }

    #[test]
    fn migration_13_repairs_a_database_that_recorded_the_old_12_backfill() {
        let path = temp_path("anonymous-migration-12-repair");
        let connection = open_through(&path, 11);
        insert_anonymous_history(&connection);
        connection
            .execute_batch(
                "ALTER TABLE documents ADD COLUMN public_edit INTEGER NOT NULL DEFAULT 0
                    CHECK(public_edit IN (0, 1));
                 ALTER TABLE documents ADD COLUMN anonymous_edit_count INTEGER NOT NULL DEFAULT 0
                    CHECK(anonymous_edit_count >= 0);
                 ALTER TABLE documents ADD COLUMN persisted_at INTEGER;
                 UPDATE documents SET public_edit = 1
                  WHERE scratch_id IS NOT NULL
                     OR EXISTS (
                        SELECT 1 FROM document_sites s
                         WHERE s.document_id = documents.id
                           AND s.authority_kind = 'scratch'
                     );
                 INSERT INTO schema_migrations(version, applied_at) VALUES (12, 12000);",
            )
            .expect("install original migration 12");
        let before: (i64, i64, Option<i64>) = connection
            .query_row(
                "SELECT public_edit, anonymous_edit_count, persisted_at
                 FROM documents WHERE id = 'document_claimed_anonymous'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(before, (0, 0, None));
        drop(connection);

        let db = Db::open(&path).expect("repair migration 12");
        assert_anonymous_history_backfilled(&db);
        drop(db);
        remove_db(&path);
    }

    #[test]
    fn a_newer_schema_refuses_this_binary() {
        let path = temp_path("schema-guard");
        Db::open(&path).expect("initial migration");
        {
            let connection = Connection::open(&path).expect("raw connection");
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![schema_version() + 1, 0_i64],
                )
                .expect("future migration row");
        }
        assert!(
            Db::open(&path).is_err(),
            "a database migrated by a newer binary must refuse this one"
        );
        remove_db(&path);
    }
}
