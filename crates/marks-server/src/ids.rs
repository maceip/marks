use base64ct::{Base64UrlUnpadded, Encoding};
use rand_core::{OsRng, RngCore};

/// `<prefix>_<base64url(16 random bytes)>`, the same opaque shape the browser
/// helper produces. Prefixes are presentation only; nothing parses them.
pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}_{}", Base64UrlUnpadded::encode_string(&bytes))
}

/// Exactly 256 random bits, the only bearer-secret size in the protocol.
pub fn new_secret() -> [u8; 32] {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn now_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before UNIX epoch")
            .as_millis(),
    )
    .expect("system clock overflow")
}
