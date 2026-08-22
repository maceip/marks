use std::collections::HashMap;
use std::sync::Mutex;

/// Fixed-window in-process rate limiter: per-IP plus per-capability keys on
/// the authentication surface. One process, one limiter (see V1 scope).
pub struct RateLimiter {
    windows: Mutex<HashMap<String, (u64, u32)>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Returns true when the caller is inside `limit` events per `window_ms`.
    pub fn allow(&self, key: &str, limit: u32, window_ms: u64, now_ms: u64) -> bool {
        let window = now_ms / window_ms.max(1);
        let mut windows = match self.windows.lock() {
            Ok(windows) => windows,
            Err(_) => return false,
        };
        if windows.len() > 65_536 {
            windows.retain(|_, (started, _)| *started == window);
        }
        let entry = windows.entry(key.to_owned()).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        entry.1 += 1;
        entry.1 <= limit
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}
