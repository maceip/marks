//! Device Bound Session Credentials (DBSC) proof validation.
//!
//! Chrome — not page JavaScript — maintains a hardware-held P-256 key per
//! registered session and proves possession with `dbsc+jwt` tokens at a
//! registration endpoint (key delivered in the token header) and a refresh
//! endpoint (signature checked against the stored key). This module validates
//! those externally-defined tokens against a stored one-use challenge.
//!
//! Unlike Marks' own signed statements, the token format here is owned by the
//! browser vendor, so unknown JWT claims are deliberately ignored: rejecting a
//! new advisory claim would break the quiet fallback the deployment depends
//! on. Every security decision — algorithm, token type, key, challenge
//! digest, session binding, expiry, one-use consumption — is still pinned in
//! this module and in the caller's transaction.

use crate::crypto::bearer_secret_hash;
use crate::{ChallengeId, SessionId};
use base64ct::{Base64UrlUnpadded, Encoding};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use subtle::ConstantTimeEq;
use thiserror::Error;

/// One-use challenge minted alongside a `Secure-Session-Registration` header
/// or a refresh 403. Only the domain-separated digest of the challenge value
/// is stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbscChallengeRecord {
    pub id: ChallengeId,
    pub session_id: SessionId,
    pub nonce_hash: [u8; 32],
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedDbscRegistration {
    /// Canonical uncompressed SEC1 point recovered from the token's JWK.
    pub public_key_sec1: Vec<u8>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DbscError {
    #[error("token is not a well-formed JWT")]
    MalformedJwt,
    #[error("token algorithm is not ES256")]
    UnsupportedAlgorithm,
    #[error("token type is not dbsc+jwt")]
    WrongTokenType,
    #[error("registration token carries no JWK")]
    MissingKey,
    #[error("token key is not a valid P-256 JWK")]
    InvalidKey,
    #[error("challenge is expired")]
    ChallengeExpired,
    #[error("challenge was already consumed")]
    ChallengeConsumed,
    #[error("token does not answer this challenge")]
    ChallengeMismatch,
    #[error("challenge is not bound to this session")]
    SessionMismatch,
    #[error("token key does not match the bound key")]
    KeyMismatch,
    #[error("token signature is invalid")]
    InvalidSignature,
}

struct ParsedToken {
    header: serde_json::Value,
    payload: serde_json::Value,
    /// ASCII `base64url(header).base64url(payload)` — the signed bytes.
    signing_input: Vec<u8>,
    /// 64-byte IEEE P1363 `r || s`.
    signature: [u8; 64],
}

fn parse_token(token: &str) -> Result<ParsedToken, DbscError> {
    let mut parts = token.split('.');
    let (Some(header_b64), Some(payload_b64), Some(signature_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(DbscError::MalformedJwt);
    };
    let header_bytes =
        Base64UrlUnpadded::decode_vec(header_b64).map_err(|_| DbscError::MalformedJwt)?;
    let payload_bytes =
        Base64UrlUnpadded::decode_vec(payload_b64).map_err(|_| DbscError::MalformedJwt)?;
    let signature_bytes =
        Base64UrlUnpadded::decode_vec(signature_b64).map_err(|_| DbscError::MalformedJwt)?;
    let signature: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| DbscError::InvalidSignature)?;
    let header: serde_json::Value =
        serde_json::from_slice(&header_bytes).map_err(|_| DbscError::MalformedJwt)?;
    let payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|_| DbscError::MalformedJwt)?;
    Ok(ParsedToken {
        header,
        payload,
        signing_input: format!("{header_b64}.{payload_b64}").into_bytes(),
        signature,
    })
}

fn require_es256_dbsc(header: &serde_json::Value) -> Result<(), DbscError> {
    if header.get("alg").and_then(|value| value.as_str()) != Some("ES256") {
        return Err(DbscError::UnsupportedAlgorithm);
    }
    let type_ok = header
        .get("typ")
        .and_then(|value| value.as_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("dbsc+jwt"));
    if !type_ok {
        return Err(DbscError::WrongTokenType);
    }
    Ok(())
}

/// Convert an EC P-256 JWK into the canonical 65-byte uncompressed SEC1 point
/// and reject anything that is not a valid curve point.
pub fn dbsc_jwk_to_sec1(jwk: &serde_json::Value) -> Result<Vec<u8>, DbscError> {
    if jwk.get("kty").and_then(|value| value.as_str()) != Some("EC")
        || jwk.get("crv").and_then(|value| value.as_str()) != Some("P-256")
    {
        return Err(DbscError::InvalidKey);
    }
    let coordinate = |name: &str| -> Result<Vec<u8>, DbscError> {
        let text = jwk
            .get(name)
            .and_then(|value| value.as_str())
            .ok_or(DbscError::InvalidKey)?;
        let bytes = Base64UrlUnpadded::decode_vec(text).map_err(|_| DbscError::InvalidKey)?;
        if bytes.len() != 32 {
            return Err(DbscError::InvalidKey);
        }
        Ok(bytes)
    };
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(0x04);
    sec1.extend_from_slice(&coordinate("x")?);
    sec1.extend_from_slice(&coordinate("y")?);
    VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| DbscError::InvalidKey)?;
    Ok(sec1)
}

fn require_live_challenge(
    challenge: &DbscChallengeRecord,
    session_id: &SessionId,
    now_ms: u64,
) -> Result<(), DbscError> {
    if challenge.consumed_at_ms.is_some() {
        return Err(DbscError::ChallengeConsumed);
    }
    if now_ms >= challenge.expires_at_ms {
        return Err(DbscError::ChallengeExpired);
    }
    if &challenge.session_id != session_id {
        return Err(DbscError::SessionMismatch);
    }
    Ok(())
}

fn require_challenge_answer(
    payload: &serde_json::Value,
    nonce_hash: &[u8; 32],
) -> Result<(), DbscError> {
    let jti = payload
        .get("jti")
        .and_then(|value| value.as_str())
        .ok_or(DbscError::ChallengeMismatch)?;
    if bearer_secret_hash(jti.as_bytes())
        .ct_eq(nonce_hash)
        .unwrap_u8()
        != 1
    {
        return Err(DbscError::ChallengeMismatch);
    }
    Ok(())
}

fn verify_signature(token: &ParsedToken, public_key_sec1: &[u8]) -> Result<(), DbscError> {
    let verifying_key =
        VerifyingKey::from_sec1_bytes(public_key_sec1).map_err(|_| DbscError::InvalidKey)?;
    let signature =
        Signature::from_slice(&token.signature).map_err(|_| DbscError::InvalidSignature)?;
    verifying_key
        .verify(&token.signing_input, &signature)
        .map_err(|_| DbscError::InvalidSignature)
}

/// Digest of the challenge value a token claims to answer, without any
/// validation. The caller uses this only to select the stored challenge row;
/// authorization still runs the full check.
pub fn peek_dbsc_challenge_hash(token: &str) -> Result<[u8; 32], DbscError> {
    let parsed = parse_token(token)?;
    let jti = parsed
        .payload
        .get("jti")
        .and_then(|value| value.as_str())
        .ok_or(DbscError::ChallengeMismatch)?;
    Ok(bearer_secret_hash(jti.as_bytes()))
}

/// Validate a registration token: the browser presents a new hardware-held
/// public key in the token header and answers the one-use challenge with a
/// signature by that key. The caller must consume the challenge and store the
/// key in the same transaction.
pub fn authorize_dbsc_registration(
    challenge: &DbscChallengeRecord,
    session_id: &SessionId,
    token: &str,
    now_ms: u64,
) -> Result<AuthorizedDbscRegistration, DbscError> {
    require_live_challenge(challenge, session_id, now_ms)?;
    let parsed = parse_token(token)?;
    require_es256_dbsc(&parsed.header)?;
    let jwk = parsed.header.get("jwk").ok_or(DbscError::MissingKey)?;
    let public_key_sec1 = dbsc_jwk_to_sec1(jwk)?;
    require_challenge_answer(&parsed.payload, &challenge.nonce_hash)?;
    verify_signature(&parsed, &public_key_sec1)?;
    Ok(AuthorizedDbscRegistration { public_key_sec1 })
}

/// Validate a refresh token against the key stored at registration. If the
/// browser repeats a JWK in the header it must be the bound key; substitution
/// fails closed. The caller must consume the challenge in the same
/// transaction that rotates the bound cookie.
pub fn authorize_dbsc_refresh(
    challenge: &DbscChallengeRecord,
    session_id: &SessionId,
    bound_public_key_sec1: &[u8],
    token: &str,
    now_ms: u64,
) -> Result<(), DbscError> {
    require_live_challenge(challenge, session_id, now_ms)?;
    let parsed = parse_token(token)?;
    require_es256_dbsc(&parsed.header)?;
    if let Some(jwk) = parsed.header.get("jwk")
        && dbsc_jwk_to_sec1(jwk)? != bound_public_key_sec1
    {
        return Err(DbscError::KeyMismatch);
    }
    require_challenge_answer(&parsed.payload, &challenge.nonce_hash)?;
    verify_signature(&parsed, bound_public_key_sec1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use rand_core::OsRng;

    fn b64(bytes: &[u8]) -> String {
        Base64UrlUnpadded::encode_string(bytes)
    }

    fn jwk_for(key: &SigningKey) -> serde_json::Value {
        let point = key.verifying_key().to_encoded_point(false);
        serde_json::json!({
            "kty": "EC",
            "crv": "P-256",
            "x": b64(point.x().unwrap()),
            "y": b64(point.y().unwrap()),
        })
    }

    fn token(key: &SigningKey, header: serde_json::Value, payload: serde_json::Value) -> String {
        let header_b64 = b64(header.to_string().as_bytes());
        let payload_b64 = b64(payload.to_string().as_bytes());
        let signing_input = format!("{header_b64}.{payload_b64}");
        let signature: Signature = key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", b64(&signature.to_bytes()))
    }

    fn challenge(value: &str) -> DbscChallengeRecord {
        DbscChallengeRecord {
            id: ChallengeId::new("challenge_dbsc1").unwrap(),
            session_id: SessionId::new("session_12345").unwrap(),
            nonce_hash: bearer_secret_hash(value.as_bytes()),
            expires_at_ms: 20_000,
            consumed_at_ms: None,
        }
    }

    #[test]
    fn a_registration_token_binds_the_hardware_key_to_the_session() {
        let key = SigningKey::random(&mut OsRng);
        let record = challenge("challenge-value-1");
        let jwt = token(
            &key,
            serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt", "jwk": jwk_for(&key) }),
            // Unknown advisory claims from the browser are ignored.
            serde_json::json!({ "jti": "challenge-value-1", "aud": "https://marks.example", "iat": 10 }),
        );
        let authorized =
            authorize_dbsc_registration(&record, &record.session_id.clone(), &jwt, 10_000).unwrap();
        assert_eq!(
            authorized.public_key_sec1,
            key.verifying_key().to_encoded_point(false).as_bytes()
        );
        assert_eq!(
            peek_dbsc_challenge_hash(&jwt).unwrap(),
            bearer_secret_hash(b"challenge-value-1")
        );
    }

    #[test]
    fn wrong_challenge_session_type_or_algorithm_fails_closed() {
        let key = SigningKey::random(&mut OsRng);
        let record = challenge("challenge-value-1");
        let header = serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt", "jwk": jwk_for(&key) });

        let wrong_challenge = token(&key, header.clone(), serde_json::json!({ "jti": "other" }));
        assert_eq!(
            authorize_dbsc_registration(
                &record,
                &record.session_id.clone(),
                &wrong_challenge,
                10_000
            ),
            Err(DbscError::ChallengeMismatch)
        );

        let other_session = SessionId::new("session_other1").unwrap();
        let jwt = token(
            &key,
            header.clone(),
            serde_json::json!({ "jti": "challenge-value-1" }),
        );
        assert_eq!(
            authorize_dbsc_registration(&record, &other_session, &jwt, 10_000),
            Err(DbscError::SessionMismatch)
        );

        let mut consumed = record.clone();
        consumed.consumed_at_ms = Some(9_000);
        assert_eq!(
            authorize_dbsc_registration(&consumed, &record.session_id.clone(), &jwt, 10_000),
            Err(DbscError::ChallengeConsumed)
        );
        assert_eq!(
            authorize_dbsc_registration(&record, &record.session_id.clone(), &jwt, 20_000),
            Err(DbscError::ChallengeExpired)
        );

        let rs256 = token(
            &key,
            serde_json::json!({ "alg": "RS256", "typ": "dbsc+jwt", "jwk": jwk_for(&key) }),
            serde_json::json!({ "jti": "challenge-value-1" }),
        );
        assert_eq!(
            authorize_dbsc_registration(&record, &record.session_id.clone(), &rs256, 10_000),
            Err(DbscError::UnsupportedAlgorithm)
        );

        let wrong_type = token(
            &key,
            serde_json::json!({ "alg": "ES256", "typ": "jwt", "jwk": jwk_for(&key) }),
            serde_json::json!({ "jti": "challenge-value-1" }),
        );
        assert_eq!(
            authorize_dbsc_registration(&record, &record.session_id.clone(), &wrong_type, 10_000),
            Err(DbscError::WrongTokenType)
        );

        let no_key = token(
            &key,
            serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt" }),
            serde_json::json!({ "jti": "challenge-value-1" }),
        );
        assert_eq!(
            authorize_dbsc_registration(&record, &record.session_id.clone(), &no_key, 10_000),
            Err(DbscError::MissingKey)
        );
    }

    #[test]
    fn a_registration_signature_must_come_from_the_presented_key() {
        let key = SigningKey::random(&mut OsRng);
        let attacker = SigningKey::random(&mut OsRng);
        let record = challenge("challenge-value-1");
        // Header advertises the victim key; attacker signs.
        let jwt = token(
            &attacker,
            serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt", "jwk": jwk_for(&key) }),
            serde_json::json!({ "jti": "challenge-value-1" }),
        );
        assert_eq!(
            authorize_dbsc_registration(&record, &record.session_id.clone(), &jwt, 10_000),
            Err(DbscError::InvalidSignature)
        );
    }

    #[test]
    fn refresh_verifies_against_the_stored_key_only() {
        let key = SigningKey::random(&mut OsRng);
        let bound = key.verifying_key().to_encoded_point(false);
        let record = challenge("challenge-refresh-1");
        let jwt = token(
            &key,
            serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt" }),
            serde_json::json!({ "jti": "challenge-refresh-1" }),
        );
        authorize_dbsc_refresh(
            &record,
            &record.session_id.clone(),
            bound.as_bytes(),
            &jwt,
            10_000,
        )
        .unwrap();

        let attacker = SigningKey::random(&mut OsRng);
        let forged = token(
            &attacker,
            serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt" }),
            serde_json::json!({ "jti": "challenge-refresh-1" }),
        );
        assert_eq!(
            authorize_dbsc_refresh(
                &record,
                &record.session_id.clone(),
                bound.as_bytes(),
                &forged,
                10_000,
            ),
            Err(DbscError::InvalidSignature)
        );

        // A repeated JWK that does not match the bound key is a substitution.
        let substituted = token(
            &attacker,
            serde_json::json!({ "alg": "ES256", "typ": "dbsc+jwt", "jwk": jwk_for(&attacker) }),
            serde_json::json!({ "jti": "challenge-refresh-1" }),
        );
        assert_eq!(
            authorize_dbsc_refresh(
                &record,
                &record.session_id.clone(),
                bound.as_bytes(),
                &substituted,
                10_000,
            ),
            Err(DbscError::KeyMismatch)
        );
    }

    #[test]
    fn malformed_tokens_never_reach_signature_verification() {
        let record = challenge("challenge-value-1");
        for bad in ["", "a.b", "a.b.c.d", "!!.??.__"] {
            assert_eq!(
                authorize_dbsc_registration(&record, &record.session_id.clone(), bad, 10_000),
                Err(DbscError::MalformedJwt)
            );
        }
    }
}
