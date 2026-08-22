use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BEARER_HASH_DOMAIN: &[u8] = b"marks-bearer-secret-v1\0";
const PUBLIC_KEY_HASH_DOMAIN: &[u8] = b"marks-public-key-v1\0";

fn domain_hash(domain: &[u8], value: &[u8]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
    digest.finalize().into()
}

/// Hash a high-entropy session, scratch, recovery, or pairing capability before
/// persistence. This is not a password hash: callers must supply at least 128
/// random bits, and the protocol uses 256 bits for new secrets.
pub fn bearer_secret_hash(secret: &[u8]) -> [u8; 32] {
    domain_hash(BEARER_HASH_DOMAIN, secret)
}

pub(crate) fn bearer_matches(
    presented: &[u8],
    expected_len: usize,
    stored_hash: &[u8; 32],
) -> bool {
    presented.len() == expected_len
        && stored_hash
            .ct_eq(&bearer_secret_hash(presented))
            .unwrap_u8()
            == 1
}

/// Stable digest of the canonical SEC1-encoded P-256 public key used in grants.
pub fn public_key_hash(public_key_sec1: &[u8]) -> [u8; 32] {
    domain_hash(PUBLIC_KEY_HASH_DOMAIN, public_key_sec1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write;

    #[test]
    fn public_key_hash_matches_the_browser_golden_fixture() {
        let public_key: [u8; 65] =
            std::array::from_fn(|index| if index == 0 { 4 } else { index as u8 });
        let mut encoded = String::new();
        for byte in public_key_hash(&public_key) {
            write!(&mut encoded, "{byte:02x}").unwrap();
        }
        assert_eq!(
            encoded,
            "df64b92cbb436c53cac8ce7cd5b6bfb86a3e63b4c60621a9d5968c9a4fb4731d"
        );
    }
}
