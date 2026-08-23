//! Four-word pairing codes for camera-less clients.
//!
//! The QR fragment remains the 256-bit pairing secret. These four BIP39
//! English words are a separate, short-lived lookup secret: 44 bits, hashed
//! with a distinct domain, valid only for the two-minute pairing window.
//! They are not a password, recovery phrase, or durable credential.

use crate::pairing::PairingError;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const PAIRING_WORDS_DOMAIN: &[u8] = b"marks-pairing-words-v1\0";
const WORDLIST_TEXT: &str = include_str!("wordlist.txt");
pub const PAIRING_WORD_COUNT: usize = 4;
const WORD_INDEX_BITS: u32 = 11;
const WORD_INDEX_MASK: u64 = (1 << WORD_INDEX_BITS) - 1;

fn wordlist() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| {
        let words: Vec<&str> = WORDLIST_TEXT
            .lines()
            .filter(|line| !line.is_empty())
            .collect();
        assert_eq!(words.len(), 2048, "BIP39 English wordlist");
        words
    })
}

/// Canonical `w1 w2 w3 w4` string, or `InvalidSecret` when the input is not
/// exactly four alphabetic BIP39 words.
pub fn normalize_pairing_words(input: &str) -> Result<String, PairingError> {
    let words: Vec<String> = input
        .split(|character: char| !character.is_ascii_alphabetic())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect();
    if words.len() != PAIRING_WORD_COUNT {
        return Err(PairingError::InvalidSecret);
    }
    let list = wordlist();
    for word in &words {
        if list.binary_search(&word.as_str()).is_err() {
            return Err(PairingError::InvalidSecret);
        }
    }
    Ok(words.join(" "))
}

/// 44 bits of CSPRNG as four BIP39 words. `entropy` is six random bytes;
/// the top four bits are discarded.
pub fn generate_pairing_words(entropy: [u8; 6]) -> String {
    let mut value = 0_u64;
    for byte in entropy {
        value = (value << 8) | u64::from(byte);
    }
    let list = wordlist();
    let mut words = Vec::with_capacity(PAIRING_WORD_COUNT);
    for index in (0..PAIRING_WORD_COUNT).rev() {
        let word_index = ((value >> (WORD_INDEX_BITS * index as u32)) & WORD_INDEX_MASK) as usize;
        words.push(list[word_index]);
    }
    words.join(" ")
}

/// Domain-separated digest of the canonical four-word string. The words
/// themselves are never stored.
pub fn pairing_word_code_hash(canonical_words: &str) -> [u8; 32] {
    let bytes = canonical_words.as_bytes();
    let mut digest = Sha256::new();
    digest.update(PAIRING_WORDS_DOMAIN);
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_sorted_bip39_english() {
        let words = wordlist();
        assert_eq!(words.len(), 2048);
        assert_eq!(words[0], "abandon");
        assert_eq!(words[2047], "zoo");
        assert!(words.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn generate_is_deterministic_and_canonical() {
        let words = generate_pairing_words([0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);
        let parts: Vec<&str> = words.split(' ').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(normalize_pairing_words(&words).unwrap(), words);
        assert_eq!(
            normalize_pairing_words(&format!(
                "  {} , {} {}   {}",
                parts[0],
                parts[1].to_uppercase(),
                parts[2],
                parts[3]
            ))
            .unwrap(),
            words
        );
    }

    #[test]
    fn hash_is_domain_separated_and_stable() {
        let first = pairing_word_code_hash("correct horse battery staple");
        let second = pairing_word_code_hash("correct horse battery staple");
        let other = pairing_word_code_hash("correct horse battery orange");
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert_ne!(first, [0_u8; 32]);
    }

    #[test]
    fn reject_wrong_counts_and_unknown_words() {
        assert!(normalize_pairing_words("correct horse battery").is_err());
        assert!(normalize_pairing_words("correct horse battery staple extra").is_err());
        assert!(normalize_pairing_words("zzzz notaword battery staple").is_err());
    }
}
