use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;
use url::Url;

use crate::{ChallengeId, DeviceId, ScratchId, bearer_secret_hash};

const EMAIL_LOCATOR_DOMAIN: &[u8] = b"marks-verified-email-locator-v1\0";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedEmailEvidence {
    /// Marks challenge record used for this browser presentation.
    pub challenge_id: ChallengeId,
    /// Verified HTTPS issuer identifier from DNS delegation and issuer metadata.
    pub issuer: String,
    /// Canonical email returned by the issuer. The auth core does not persist it.
    pub canonical_email: String,
    /// Exact Marks origin from the key-bound presentation audience.
    pub audience: String,
    /// Fresh nonce generated and consumed by Marks for this presentation.
    pub nonce: String,
    pub issued_at_ms: u64,
    /// Adapter identifier, e.g. `chrome-evt-origin-trial-2026-08`.
    pub adapter_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmailChallengeRecord {
    pub id: ChallengeId,
    pub scratch_id: ScratchId,
    pub pending_device_id: DeviceId,
    pub pending_device_public_key_hash: [u8; 32],
    pub nonce_hash: [u8; 32],
    pub audience: String,
    pub adapter_version: String,
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmailLocator([u8; 32]);

impl EmailLocator {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedEmailLocatorRecord {
    pub locator_key_version: u32,
    pub locator: EmailLocator,
    pub principal_id: crate::PrincipalId,
    pub issuer_policy_version: u32,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedEmailPromotion {
    pub scratch_id: ScratchId,
    pub pending_device_id: DeviceId,
    pub pending_device_public_key_hash: [u8; 32],
    pub locator: EmailLocator,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum EmailLocatorError {
    #[error("email verification challenge was already consumed")]
    ChallengeConsumed,
    #[error("email verification challenge is expired")]
    ChallengeExpired,
    #[error("email verification challenge binding does not match")]
    ChallengeMismatch,
    #[error("email verification nonce is invalid")]
    InvalidNonce,
    #[error("verified email evidence has an unexpected audience")]
    AudienceMismatch,
    #[error("verified email evidence has an unexpected nonce")]
    NonceMismatch,
    #[error("verified email evidence is from the future")]
    IssuedInFuture,
    #[error("verified email evidence is stale")]
    Stale,
    #[error("verified email issuer must be an HTTPS origin")]
    InvalidIssuer,
    #[error("verified email is empty")]
    EmptyEmail,
    #[error("email locator key is too short")]
    WeakLocatorKey,
}

/// Validate freshness and relying-party bindings after the feature-specific EVT
/// adapter has verified DNS delegation, SD-JWT parsing, issuer signature, and
/// browser key binding. A nonce must still be consumed transactionally by the
/// server; this function only compares it in constant time.
pub fn validate_verified_email_evidence(
    evidence: &VerifiedEmailEvidence,
    expected_audience: &str,
    expected_nonce: &str,
    now_ms: u64,
    max_age_ms: u64,
) -> Result<(), EmailLocatorError> {
    if evidence.audience != expected_audience {
        return Err(EmailLocatorError::AudienceMismatch);
    }
    if evidence
        .nonce
        .as_bytes()
        .ct_eq(expected_nonce.as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err(EmailLocatorError::NonceMismatch);
    }
    if evidence.issued_at_ms > now_ms.saturating_add(60_000) {
        return Err(EmailLocatorError::IssuedInFuture);
    }
    if now_ms.saturating_sub(evidence.issued_at_ms) > max_age_ms {
        return Err(EmailLocatorError::Stale);
    }
    let issuer = Url::parse(&evidence.issuer).map_err(|_| EmailLocatorError::InvalidIssuer)?;
    if issuer.scheme() != "https"
        || issuer.host_str().is_none()
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
        || issuer.path() != "/"
        || issuer.origin().ascii_serialization() != evidence.issuer
    {
        return Err(EmailLocatorError::InvalidIssuer);
    }
    if evidence.canonical_email.trim().is_empty() {
        return Err(EmailLocatorError::EmptyEmail);
    }
    Ok(())
}

/// Validate the experimental EVT adapter's trusted evidence against the exact
/// one-use challenge that was bound to the scratch workspace and pending
/// browser key. The raw email and token must be dropped after the caller uses
/// the returned private locator in its promotion transaction.
pub fn authorize_email_promotion(
    challenge: &EmailChallengeRecord,
    presented_nonce: &str,
    evidence: &VerifiedEmailEvidence,
    locator_key: &[u8],
    now_ms: u64,
    max_evidence_age_ms: u64,
) -> Result<AuthorizedEmailPromotion, EmailLocatorError> {
    if challenge.consumed_at_ms.is_some() {
        return Err(EmailLocatorError::ChallengeConsumed);
    }
    if now_ms >= challenge.expires_at_ms {
        return Err(EmailLocatorError::ChallengeExpired);
    }
    if evidence.challenge_id != challenge.id
        || evidence.audience != challenge.audience
        || evidence.adapter_version != challenge.adapter_version
    {
        return Err(EmailLocatorError::ChallengeMismatch);
    }
    if presented_nonce.len() < 32
        || evidence
            .nonce
            .as_bytes()
            .ct_eq(presented_nonce.as_bytes())
            .unwrap_u8()
            != 1
        || challenge
            .nonce_hash
            .ct_eq(&bearer_secret_hash(presented_nonce.as_bytes()))
            .unwrap_u8()
            != 1
    {
        return Err(EmailLocatorError::InvalidNonce);
    }

    validate_verified_email_evidence(
        evidence,
        &challenge.audience,
        presented_nonce,
        now_ms,
        max_evidence_age_ms,
    )?;
    let locator = derive_email_locator(locator_key, evidence)?;

    Ok(AuthorizedEmailPromotion {
        scratch_id: challenge.scratch_id.clone(),
        pending_device_id: challenge.pending_device_id.clone(),
        pending_device_public_key_hash: challenge.pending_device_public_key_hash,
        locator,
    })
}

/// Produce the only stable email value Marks needs to retain for account
/// lookup. This is data minimization, not anonymity: Marks observes the email
/// while validating the presentation. `locator_key` must be versioned and kept
/// outside the database so a database leak cannot enumerate common addresses.
pub fn derive_email_locator(
    locator_key: &[u8],
    evidence: &VerifiedEmailEvidence,
) -> Result<EmailLocator, EmailLocatorError> {
    if locator_key.len() < 32 {
        return Err(EmailLocatorError::WeakLocatorKey);
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(locator_key)
        .expect("HMAC-SHA256 accepts arbitrary key lengths");
    mac.update(EMAIL_LOCATOR_DOMAIN);
    put_field(&mut mac, evidence.issuer.as_bytes());
    put_field(&mut mac, evidence.canonical_email.as_bytes());
    Ok(EmailLocator(mac.finalize().into_bytes().into()))
}

fn put_field(mac: &mut Hmac<Sha256>, value: &[u8]) {
    mac.update(&(value.len() as u64).to_be_bytes());
    mac.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "nonce_1234567890123456789012345678901234567890";

    fn evidence() -> VerifiedEmailEvidence {
        VerifiedEmailEvidence {
            challenge_id: ChallengeId::new("challenge_12345").unwrap(),
            issuer: "https://accounts.example".into(),
            canonical_email: "person@example.test".into(),
            audience: "https://marks.example".into(),
            nonce: NONCE.into(),
            issued_at_ms: 10_000,
            adapter_version: "test-evt-v1".into(),
        }
    }

    #[test]
    fn same_verified_claim_maps_to_the_same_private_locator() {
        let key = [8_u8; 32];
        let first = derive_email_locator(&key, &evidence()).unwrap();
        let second = derive_email_locator(&key, &evidence()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn issuer_is_part_of_the_locator() {
        let key = [8_u8; 32];
        let first = derive_email_locator(&key, &evidence()).unwrap();
        let mut other = evidence();
        other.issuer = "https://other-issuer.example".into();
        let second = derive_email_locator(&key, &other).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn audience_nonce_and_freshness_are_required() {
        let evidence = evidence();
        assert_eq!(
            validate_verified_email_evidence(
                &evidence,
                "https://marks.example",
                NONCE,
                10_500,
                2_000,
            ),
            Ok(())
        );
        assert_eq!(
            validate_verified_email_evidence(
                &evidence,
                "https://evil.example",
                NONCE,
                10_500,
                2_000,
            ),
            Err(EmailLocatorError::AudienceMismatch)
        );
        assert_eq!(
            validate_verified_email_evidence(
                &evidence,
                "https://marks.example",
                "wrong_nonce",
                10_500,
                2_000,
            ),
            Err(EmailLocatorError::NonceMismatch)
        );
        assert_eq!(
            validate_verified_email_evidence(
                &evidence,
                "https://marks.example",
                NONCE,
                20_000,
                2_000,
            ),
            Err(EmailLocatorError::Stale)
        );
    }

    #[test]
    fn email_promotion_is_bound_to_one_scratch_workspace_and_device() {
        let evidence = evidence();
        let challenge = EmailChallengeRecord {
            id: evidence.challenge_id.clone(),
            scratch_id: ScratchId::new("scratch_123456").unwrap(),
            pending_device_id: DeviceId::new("device_1234567").unwrap(),
            pending_device_public_key_hash: [3; 32],
            nonce_hash: bearer_secret_hash(evidence.nonce.as_bytes()),
            audience: evidence.audience.clone(),
            adapter_version: evidence.adapter_version.clone(),
            expires_at_ms: 12_000,
            consumed_at_ms: None,
        };

        let promotion = authorize_email_promotion(
            &challenge,
            &evidence.nonce,
            &evidence,
            &[8; 32],
            10_500,
            2_000,
        )
        .unwrap();
        assert_eq!(promotion.scratch_id, challenge.scratch_id);
        assert_eq!(promotion.pending_device_id, challenge.pending_device_id);
        assert_eq!(promotion.pending_device_public_key_hash, [3; 32]);
    }

    #[test]
    fn email_promotion_rejects_nonce_replay_and_challenge_substitution() {
        let evidence = evidence();
        let mut challenge = EmailChallengeRecord {
            id: evidence.challenge_id.clone(),
            scratch_id: ScratchId::new("scratch_123456").unwrap(),
            pending_device_id: DeviceId::new("device_1234567").unwrap(),
            pending_device_public_key_hash: [3; 32],
            nonce_hash: bearer_secret_hash(evidence.nonce.as_bytes()),
            audience: evidence.audience.clone(),
            adapter_version: evidence.adapter_version.clone(),
            expires_at_ms: 12_000,
            consumed_at_ms: Some(10_100),
        };
        assert_eq!(
            authorize_email_promotion(
                &challenge,
                &evidence.nonce,
                &evidence,
                &[8; 32],
                10_500,
                2_000,
            ),
            Err(EmailLocatorError::ChallengeConsumed)
        );

        challenge.consumed_at_ms = None;
        challenge.id = ChallengeId::new("challenge_other1").unwrap();
        assert_eq!(
            authorize_email_promotion(
                &challenge,
                &evidence.nonce,
                &evidence,
                &[8; 32],
                10_500,
                2_000,
            ),
            Err(EmailLocatorError::ChallengeMismatch)
        );

        challenge.id = evidence.challenge_id.clone();
        challenge.adapter_version = "retired-adapter".into();
        assert_eq!(
            authorize_email_promotion(
                &challenge,
                &evidence.nonce,
                &evidence,
                &[8; 32],
                10_500,
                2_000,
            ),
            Err(EmailLocatorError::ChallengeMismatch)
        );
    }

    #[test]
    fn canonical_email_is_not_silently_case_folded() {
        let key = [8_u8; 32];
        let lower = derive_email_locator(&key, &evidence()).unwrap();
        let mut other = evidence();
        other.canonical_email = "Person@example.test".into();
        let mixed = derive_email_locator(&key, &other).unwrap();
        assert_ne!(lower, mixed);
    }
}
