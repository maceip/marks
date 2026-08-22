use crate::error::{ApiError, ApiResult};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

/// One transactional SQLite database behind one writer lock. This is the v1
/// deployment shape from `docs/V1-SCOPE.md`: one process, one database.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> ApiResult<Self> {
        let conn = if path.as_os_str() == ":memory:" {
            Connection::open_in_memory()?
        } else {
            Connection::open(path)?
        };
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Run read-only work on the connection.
    pub fn read<T>(&self, work: impl FnOnce(&Connection) -> ApiResult<T>) -> ApiResult<T> {
        let conn = self.conn.lock().map_err(|_| ApiError::internal())?;
        work(&conn)
    }

    /// Run one immediate transaction. The closure either commits atomically
    /// or everything rolls back; validators never pair with unguarded writes.
    pub fn tx<T>(&self, work: impl FnOnce(&Connection) -> ApiResult<T>) -> ApiResult<T> {
        let mut conn = self.conn.lock().map_err(|_| ApiError::internal())?;
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
    }

    fn migrate(&self) -> ApiResult<()> {
        let conn = self.conn.lock().map_err(|_| ApiError::internal())?;
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
        for (version, sql) in MIGRATIONS {
            if *version <= applied {
                continue;
            }
            conn.execute_batch(&format!("BEGIN IMMEDIATE;\n{sql}\nCOMMIT;"))?;
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![version, crate::ids::now_ms() as i64],
            )?;
        }
        Ok(())
    }
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
];
