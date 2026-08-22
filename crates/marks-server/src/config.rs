use std::net::SocketAddr;
use std::path::PathBuf;

/// Runtime configuration. Everything is supplied by environment variables so
/// the production artifact has exactly one configuration mechanism.
#[derive(Clone, Debug)]
pub struct Config {
    /// Socket address the server binds.
    pub listen: SocketAddr,
    /// SQLite database path. `:memory:` is only for tests.
    pub database: PathBuf,
    /// Exact external origin (scheme + host + port) used for `Origin` checks,
    /// device-challenge audiences, and pairing links, e.g. `https://marks.app`.
    pub origin: String,
    /// Optional directory with the built browser client. When set, unknown
    /// GET paths serve the SPA.
    pub static_dir: Option<PathBuf>,
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
    /// Upper bound for one WebSocket frame accepted from a client.
    pub max_frame_bytes: usize,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let listen = std::env::var("MARKS_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:3000".to_owned())
            .parse::<SocketAddr>()
            .map_err(|error| format!("MARKS_LISTEN is not a socket address: {error}"))?;
        let database =
            PathBuf::from(std::env::var("MARKS_DB").unwrap_or_else(|_| "marks.db3".to_owned()));
        let origin = std::env::var("MARKS_ORIGIN").unwrap_or_else(|_| format!("http://{listen}"));
        validate_origin(&origin)?;
        let static_dir = std::env::var("MARKS_STATIC_DIR").ok().map(PathBuf::from);
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
        Ok(Self {
            listen,
            database,
            origin,
            static_dir,
            evt_enabled,
            evt_locator_key,
            evt_locator_key_version: 1,
            evt_adapter_version: std::env::var("MARKS_EVT_ADAPTER_VERSION")
                .unwrap_or_else(|_| "chrome-evt-origin-trial-2026-08".to_owned()),
            scratch_ttl_ms: 24 * 60 * 60 * 1000,
            session_ttl_ms: 30 * 24 * 60 * 60 * 1000,
            session_rotate_after_ms: 24 * 60 * 60 * 1000,
            pairing_ttl_ms: 2 * 60 * 1000,
            challenge_ttl_ms: 2 * 60 * 1000,
            compact_every_updates: 256,
            max_frame_bytes: 4 * 1024 * 1024,
        })
    }
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

fn decode_hex(text: &str) -> Result<Vec<u8>, ()> {
    if !text.len().is_multiple_of(2) {
        return Err(());
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(|_| ()))
        .collect()
}
