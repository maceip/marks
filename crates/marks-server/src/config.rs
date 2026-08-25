use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentProviderKind {
    Disabled,
    OpenAi,
}

/// Server-owned agent configuration. Provider credentials and model selection
/// are deployment policy: neither is accepted from a browser request.
#[derive(Clone, Debug)]
pub struct AgentConfig {
    pub provider: AgentProviderKind,
    pub openai_api_key_file: Option<PathBuf>,
    pub openai_model: Option<String>,
    pub max_concurrent_runs: usize,
    pub max_concurrent_runs_per_session: usize,
    pub max_runs_per_hour: u32,
    pub max_runtime_ms: u64,
    pub event_retention_ms: u64,
    pub tool_wait_ms: u64,
    pub max_output_tokens: u32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            provider: AgentProviderKind::Disabled,
            openai_api_key_file: None,
            openai_model: None,
            max_concurrent_runs: 8,
            max_concurrent_runs_per_session: 2,
            max_runs_per_hour: 30,
            max_runtime_ms: 10 * 60 * 1_000,
            event_retention_ms: 15 * 60 * 1_000,
            tool_wait_ms: 2 * 60 * 1_000,
            max_output_tokens: 4_096,
        }
    }
}

/// Runtime configuration. Everything is supplied by environment variables so
/// the production artifact has exactly one configuration mechanism.
#[derive(Clone, Debug)]
pub struct Config {
    /// Socket address the server binds.
    pub listen: SocketAddr,
    /// SQLite database path. `:memory:` is only for tests.
    pub database: PathBuf,
    /// Content-addressed binary store. Asset bytes stay off the serialized
    /// SQLite writer; only bounded ownership metadata is transactional.
    pub asset_dir: PathBuf,
    pub max_asset_bytes: usize,
    pub max_asset_bytes_per_document: u64,
    /// Portable exports run compression and disk reads on blocking workers.
    /// This admission cap bounds their aggregate I/O and channel memory.
    pub max_concurrent_bundle_exports: usize,
    /// Optional application-coordinated backup root. The server snapshots the
    /// SQLite main database and content-addressed assets under one barrier.
    pub backup_dir: Option<PathBuf>,
    pub backup_interval_ms: u64,
    pub backup_retain: usize,
    /// Exact external origin (scheme + host + port) used for `Origin` checks,
    /// device-challenge audiences, and pairing links, e.g. `https://marks.app`.
    pub origin: String,
    /// Optional directory with the built browser client. When set, unknown
    /// GET paths serve the SPA.
    pub static_dir: Option<PathBuf>,
    /// Optional shared pool of hashed assets from every retained release.
    /// An open tab from a previous release resolves its lazy chunks here
    /// after a deployment instead of receiving 404s. Entries are content-
    /// hashed by the client build, so the union across releases is safe.
    pub asset_pool: Option<PathBuf>,
    /// Optional explicit path to the process-isolated import worker. Production
    /// re-executes the current `marks-server` artifact; integration tests point
    /// at Cargo's separately-built server binary instead of their test harness.
    pub import_worker_path: Option<PathBuf>,
    /// Device Bound Session Credentials: send `Secure-Session-Registration`
    /// on login responses and serve the register/refresh endpoints. Browsers
    /// without DBSC support ignore the header entirely, so this is additive.
    pub dbsc_enabled: bool,
    /// Feature flag for the experimental Chrome EVT promotion rail.
    pub evt_enabled: bool,
    /// Versioned HMAC key for verified-email locators. Lives outside the
    /// database on purpose. Required when `evt_enabled`.
    pub evt_locator_key: Vec<u8>,
    pub evt_locator_key_version: u32,
    /// Adapter identifier the EVT challenge/redeem pair is pinned to.
    pub evt_adapter_version: String,
    /// Scratch workspace lifetime.
    pub scratch_ttl_ms: u64,
    /// Rotating session lifetime and rotation interval.
    pub session_ttl_ms: u64,
    pub session_rotate_after_ms: u64,
    /// Pairing and device-challenge lifetime.
    pub pairing_ttl_ms: u64,
    pub challenge_ttl_ms: u64,
    /// Journal rows accumulated before a room compacts into a snapshot.
    pub compact_every_updates: u64,
    /// Retained CRDT operations trigger compaction even when a few large paste
    /// transactions have not reached the row threshold.
    pub compact_every_operations: usize,
    /// Consecutive room mutations share one FULL-sync SQLite commit. The tiny
    /// window is below an animation frame and does not delay local editing,
    /// while a paste storm or many peers avoid one fsync per envelope.
    pub commit_batch_delay_ms: u64,
    pub commit_batch_max: usize,
    /// Resident CRDT state is released after the final socket stays gone.
    pub room_idle_ms: u64,
    /// Admission bounds keep one document or a spray of cold document IDs
    /// from consuming the process. The CRDT profile separately bounds each
    /// document's materialized state.
    pub max_resident_rooms: usize,
    pub max_connections_per_room: usize,
    /// Durable mutations are rate-limited per admitted socket. Presence and
    /// transport heartbeat frames do not consume this budget.
    pub max_mutations_per_second: u32,
    pub max_mutation_bytes_per_second: usize,
    /// The server drives WebSocket keepalive. A browser automatically answers
    /// ping with pong; a peer that cannot drain or answer is evicted.
    pub websocket_ping_ms: u64,
    pub websocket_idle_ms: u64,
    /// Database writeability is proven out of band from health-check traffic.
    pub database_heartbeat_ms: u64,
    pub database_heartbeat_stale_ms: u64,
    /// Upper bound for one WebSocket frame accepted from a client.
    pub max_frame_bytes: usize,
    /// Optional, session-only in-page agent gateway. Disabled by default.
    pub agent: AgentConfig,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let listen = std::env::var("MARKS_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:3000".to_owned())
            .parse::<SocketAddr>()
            .map_err(|error| format!("MARKS_LISTEN is not a socket address: {error}"))?;
        let database =
            PathBuf::from(std::env::var("MARKS_DB").unwrap_or_else(|_| "marks.db3".to_owned()));
        let asset_dir = std::env::var("MARKS_ASSET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                database
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .join("marks-assets")
            });
        let origin = std::env::var("MARKS_ORIGIN").unwrap_or_else(|_| format!("http://{listen}"));
        validate_origin(&origin)?;
        let static_dir = std::env::var("MARKS_STATIC_DIR").ok().map(PathBuf::from);
        let asset_pool = std::env::var("MARKS_ASSET_POOL").ok().map(PathBuf::from);
        let import_worker_path = std::env::var("MARKS_IMPORT_WORKER_PATH")
            .ok()
            .map(PathBuf::from);
        // Sessions must outlive script-writable storage eviction: the cookie
        // is server-set (exempt from Safari's 7-day proactive eviction) and
        // rotation on use keeps an active device signed in indefinitely.
        let session_ttl_days: u64 = match std::env::var("MARKS_SESSION_TTL_DAYS") {
            Ok(value) => value
                .parse()
                .ok()
                .filter(|days| (1..=400).contains(days))
                .ok_or("MARKS_SESSION_TTL_DAYS must be 1..=400 days")?,
            Err(_) => 180,
        };
        let dbsc_enabled = std::env::var("MARKS_DBSC_ENABLED").map_or(true, |value| value == "1");
        let backup_dir = std::env::var("MARKS_BACKUP_DIR").ok().map(PathBuf::from);
        if backup_dir
            .as_ref()
            .is_some_and(|path| path == &asset_dir || path == &database)
        {
            return Err(
                "MARKS_BACKUP_DIR must be separate from MARKS_DB and MARKS_ASSET_DIR".into(),
            );
        }
        let evt_enabled = std::env::var("MARKS_EVT_ENABLED").is_ok_and(|value| value == "1");
        let evt_locator_key = match std::env::var("MARKS_EVT_LOCATOR_KEY") {
            Ok(hex) => {
                decode_hex(&hex).map_err(|_| "MARKS_EVT_LOCATOR_KEY is not hex".to_owned())?
            }
            Err(_) if evt_enabled => {
                return Err("MARKS_EVT_LOCATOR_KEY is required when MARKS_EVT_ENABLED=1".into());
            }
            Err(_) => Vec::new(),
        };
        if evt_enabled && evt_locator_key.len() < 32 {
            return Err("MARKS_EVT_LOCATOR_KEY must hold at least 32 bytes".into());
        }
        let websocket_ping_ms = env_u64("MARKS_WS_PING_MS", 15_000, 1_000, 300_000)?;
        let websocket_idle_ms = env_u64("MARKS_WS_IDLE_MS", 45_000, 2_000, 900_000)?;
        if websocket_idle_ms <= websocket_ping_ms {
            return Err("MARKS_WS_IDLE_MS must exceed MARKS_WS_PING_MS".to_owned());
        }
        let database_heartbeat_ms = env_u64("MARKS_DB_HEARTBEAT_MS", 10_000, 1_000, 300_000)?;
        let database_heartbeat_stale_ms =
            env_u64("MARKS_DB_HEARTBEAT_STALE_MS", 45_000, 2_000, 900_000)?;
        if database_heartbeat_stale_ms <= database_heartbeat_ms {
            return Err("MARKS_DB_HEARTBEAT_STALE_MS must exceed MARKS_DB_HEARTBEAT_MS".to_owned());
        }
        let agent_provider = match std::env::var("MARKS_AGENT_PROVIDER") {
            Err(std::env::VarError::NotPresent) => AgentProviderKind::Disabled,
            Ok(value) if value == "disabled" => AgentProviderKind::Disabled,
            Ok(value) if value == "openai" => AgentProviderKind::OpenAi,
            Ok(value) => {
                return Err(format!(
                    "MARKS_AGENT_PROVIDER must be disabled or openai, got {value:?}"
                ));
            }
            Err(error) => return Err(format!("cannot read MARKS_AGENT_PROVIDER: {error}")),
        };
        let openai_api_key_file = std::env::var("MARKS_OPENAI_API_KEY_FILE")
            .ok()
            .map(PathBuf::from);
        let openai_model = std::env::var("MARKS_OPENAI_MODEL").ok();
        if agent_provider == AgentProviderKind::OpenAi {
            if openai_api_key_file.is_none() {
                return Err(
                    "MARKS_OPENAI_API_KEY_FILE is required when MARKS_AGENT_PROVIDER=openai".into(),
                );
            }
            let Some(model) = openai_model.as_deref() else {
                return Err(
                    "MARKS_OPENAI_MODEL is required when MARKS_AGENT_PROVIDER=openai".into(),
                );
            };
            validate_model_name(model)?;
        }
        Ok(Self {
            listen,
            database,
            asset_dir,
            max_asset_bytes: env_usize(
                "MARKS_MAX_ASSET_BYTES",
                10 * 1024 * 1024,
                1_024,
                64 * 1024 * 1024,
            )?,
            max_asset_bytes_per_document: env_u64(
                "MARKS_MAX_DOCUMENT_ASSET_BYTES",
                128 * 1024 * 1024,
                1_024,
                1024 * 1024 * 1024,
            )?,
            max_concurrent_bundle_exports: env_usize("MARKS_MAX_BUNDLE_EXPORTS", 4, 1, 64)?,
            backup_dir,
            backup_interval_ms: env_u64(
                "MARKS_BACKUP_INTERVAL_MS",
                24 * 60 * 60 * 1000,
                60_000,
                7 * 24 * 60 * 60 * 1000,
            )?,
            backup_retain: env_usize("MARKS_BACKUP_RETAIN", 14, 2, 365)?,
            origin,
            static_dir,
            asset_pool,
            import_worker_path,
            dbsc_enabled,
            evt_enabled,
            evt_locator_key,
            evt_locator_key_version: 1,
            evt_adapter_version: std::env::var("MARKS_EVT_ADAPTER_VERSION")
                .unwrap_or_else(|_| "chrome-evt-origin-trial-2026-08".to_owned()),
            scratch_ttl_ms: 24 * 60 * 60 * 1000,
            session_ttl_ms: session_ttl_days * 24 * 60 * 60 * 1000,
            session_rotate_after_ms: 24 * 60 * 60 * 1000,
            pairing_ttl_ms: 2 * 60 * 1000,
            challenge_ttl_ms: 2 * 60 * 1000,
            compact_every_updates: 256,
            compact_every_operations: crate::engine_profile::get()?.server_compact_operations,
            commit_batch_delay_ms: env_u64("MARKS_COMMIT_BATCH_DELAY_MS", 2, 0, 20)?,
            commit_batch_max: env_usize("MARKS_COMMIT_BATCH_MAX", 64, 1, 1_024)?,
            room_idle_ms: 60_000,
            max_resident_rooms: env_usize("MARKS_MAX_RESIDENT_ROOMS", 1_024, 1, 65_536)?,
            max_connections_per_room: env_usize("MARKS_MAX_ROOM_CONNECTIONS", 128, 1, 4_096)?,
            max_mutations_per_second: env_u32("MARKS_MAX_MUTATIONS_PER_SECOND", 512, 1, 100_000)?,
            max_mutation_bytes_per_second: env_usize(
                "MARKS_MAX_MUTATION_BYTES_PER_SECOND",
                64 * 1024 * 1024,
                1_024,
                1024 * 1024 * 1024,
            )?,
            websocket_ping_ms,
            websocket_idle_ms,
            database_heartbeat_ms,
            database_heartbeat_stale_ms,
            max_frame_bytes: crate::engine_profile::get()?.max_frame_bytes,
            agent: AgentConfig {
                provider: agent_provider,
                openai_api_key_file,
                openai_model,
                max_concurrent_runs: env_usize("MARKS_AGENT_MAX_CONCURRENT_RUNS", 8, 1, 64)?,
                max_concurrent_runs_per_session: env_usize(
                    "MARKS_AGENT_MAX_RUNS_PER_SESSION",
                    2,
                    1,
                    8,
                )?,
                max_runs_per_hour: env_u32("MARKS_AGENT_MAX_RUNS_PER_HOUR", 30, 1, 1_000)?,
                max_runtime_ms: env_u64(
                    "MARKS_AGENT_MAX_RUNTIME_MS",
                    10 * 60 * 1_000,
                    5_000,
                    30 * 60 * 1_000,
                )?,
                event_retention_ms: env_u64(
                    "MARKS_AGENT_EVENT_RETENTION_MS",
                    15 * 60 * 1_000,
                    60_000,
                    24 * 60 * 60 * 1_000,
                )?,
                tool_wait_ms: env_u64(
                    "MARKS_AGENT_TOOL_WAIT_MS",
                    2 * 60 * 1_000,
                    5_000,
                    10 * 60 * 1_000,
                )?,
                max_output_tokens: env_u32("MARKS_AGENT_MAX_OUTPUT_TOKENS", 4_096, 128, 32_768)?,
            },
        })
    }
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .map_err(|error| format!("{name} is not an integer: {error}"))?,
        Err(std::env::VarError::NotPresent) => default,
        Err(error) => return Err(format!("cannot read {name}: {error}")),
    };
    if !(min..=max).contains(&value) {
        return Err(format!("{name} must be in {min}..={max}, got {value}"));
    }
    Ok(value)
}

fn env_u32(name: &str, default: u32, min: u32, max: u32) -> Result<u32, String> {
    env_u64(name, u64::from(default), u64::from(min), u64::from(max)).map(|value| value as u32)
}

fn env_usize(name: &str, default: usize, min: usize, max: usize) -> Result<usize, String> {
    env_u64(name, default as u64, min as u64, max as u64).map(|value| value as usize)
}

fn validate_origin(origin: &str) -> Result<(), String> {
    if !(origin.starts_with("http://") || origin.starts_with("https://"))
        || origin.ends_with('/')
        || origin.contains('#')
        || origin.contains('?')
    {
        return Err(format!(
            "MARKS_ORIGIN must be a bare origin, got {origin:?}"
        ));
    }
    Ok(())
}

fn validate_model_name(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("MARKS_OPENAI_MODEL is invalid".to_owned());
    }
    Ok(())
}

fn decode_hex(text: &str) -> Result<Vec<u8>, ()> {
    if !text.len().is_multiple_of(2) {
        return Err(());
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(|_| ()))
        .collect()
}
