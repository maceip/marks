use crate::wire::{put_bytes, put_text, put_u8, put_u64};
use crate::{
    ChallengeId, DeviceCapabilities, DeviceId, DeviceRecord, PrincipalId, bearer_secret_hash,
};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;

const DEVICE_SESSION_DOMAIN: &[u8] = b"marks-device-session-v1\0";
const CHALLENGE_BYTES: usize = 32;
const MAX_CLOCK_SKEW_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceChallengeRecord {
    pub id: ChallengeId,
    pub device_id: DeviceId,
    pub challenge_hash: [u8; 32],
    pub audience: String,
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSessionProof {
    pub version: u8,
    pub challenge_id: ChallengeId,
    pub device_id: DeviceId,
    pub device_key_epoch: u64,
    pub audience: String,
    pub challenge: [u8; CHALLENGE_BYTES],
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

impl DeviceSessionProof {
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(240);
        bytes.extend_from_slice(DEVICE_SESSION_DOMAIN);
        put_u8(&mut bytes, self.version);
        put_text(&mut bytes, self.challenge_id.as_str());
        put_text(&mut bytes, self.device_id.as_str());
        put_u64(&mut bytes, self.device_key_epoch);
        put_text(&mut bytes, &self.audience);
        put_bytes(&mut bytes, &self.challenge);
        put_u64(&mut bytes, self.issued_at_ms);
        put_u64(&mut bytes, self.expires_at_ms);
        bytes
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedDevice {
    pub principal_id: PrincipalId,
    pub device_id: DeviceId,
    pub capabilities: DeviceCapabilities,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DeviceSessionError {
    #[error("unsupported device session proof version")]
    UnsupportedVersion,
    #[error("device challenge was already consumed")]
    Consumed,
    #[error("device challenge or proof is expired")]
    Expired,
    #[error("device session proof was issued too far in the future")]
    IssuedInFuture,
    #[error("device session proof outlives its challenge")]
    ProofOutlivesChallenge,
    #[error("device challenge is invalid")]
    InvalidChallenge,
    #[error("device challenge binding does not match")]
    ChallengeMismatch,
    #[error("device is revoked")]
    DeviceRevoked,
    #[error("device key is invalid")]
    InvalidDeviceKey,
    #[error("device signature is invalid")]
    InvalidSignature,
}

/// Validate silent login by an enrolled origin-scoped device key. The caller
/// must consume the challenge and create the rotating session in one database
/// transaction after this returns.
pub fn authorize_device_session(
    challenge: &DeviceChallengeRecord,
    device: &DeviceRecord,
    proof: &DeviceSessionProof,
    signature_p1363: &[u8],
    now_ms: u64,
) -> Result<AuthenticatedDevice, DeviceSessionError> {
    if proof.version != 1 {
        return Err(DeviceSessionError::UnsupportedVersion);
    }
    if challenge.consumed_at_ms.is_some() {
        return Err(DeviceSessionError::Consumed);
    }
    if now_ms >= challenge.expires_at_ms || now_ms >= proof.expires_at_ms {
        return Err(DeviceSessionError::Expired);
    }
    if proof.issued_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(DeviceSessionError::IssuedInFuture);
    }
    if proof.expires_at_ms > challenge.expires_at_ms {
        return Err(DeviceSessionError::ProofOutlivesChallenge);
    }
    if proof.challenge.len() != CHALLENGE_BYTES
        || challenge
            .challenge_hash
            .ct_eq(&bearer_secret_hash(&proof.challenge))
            .unwrap_u8()
            != 1
    {
        return Err(DeviceSessionError::InvalidChallenge);
    }
    if proof.challenge_id != challenge.id
        || proof.device_id != challenge.device_id
        || proof.device_id != device.id
        || proof.device_key_epoch != device.key_epoch
        || proof.audience != challenge.audience
    {
        return Err(DeviceSessionError::ChallengeMismatch);
    }
    if device.revoked_at_ms.is_some() {
        return Err(DeviceSessionError::DeviceRevoked);
    }

    let verifying_key = VerifyingKey::from_sec1_bytes(&device.public_key_sec1)
        .map_err(|_| DeviceSessionError::InvalidDeviceKey)?;
    let signature =
        Signature::from_slice(signature_p1363).map_err(|_| DeviceSessionError::InvalidSignature)?;
    verifying_key
        .verify(&proof.signing_bytes(), &signature)
        .map_err(|_| DeviceSessionError::InvalidSignature)?;

    Ok(AuthenticatedDevice {
        principal_id: device.principal_id.clone(),
        device_id: device.id.clone(),
        capabilities: device.capabilities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use rand_core::OsRng;

    struct Fixture {
        signing_key: SigningKey,
        challenge: DeviceChallengeRecord,
        device: DeviceRecord,
        proof: DeviceSessionProof,
    }

    fn fixture() -> Fixture {
        let signing_key = SigningKey::random(&mut OsRng);
        let device_id = DeviceId::new("device_1234567").unwrap();
        let challenge_bytes = [6_u8; CHALLENGE_BYTES];
        let challenge = DeviceChallengeRecord {
            id: ChallengeId::new("challenge_12345").unwrap(),
            device_id: device_id.clone(),
            challenge_hash: bearer_secret_hash(&challenge_bytes),
            audience: "https://marks.example".into(),
            expires_at_ms: 20_000,
            consumed_at_ms: None,
        };
        let device = DeviceRecord {
            id: device_id.clone(),
            principal_id: PrincipalId::new("principal_1234").unwrap(),
            public_key_sec1: signing_key
                .verifying_key()
                .to_encoded_point(true)
                .as_bytes()
                .to_vec(),
            key_epoch: 3,
            capabilities: DeviceCapabilities::MEMBER,
            revoked_at_ms: None,
        };
        let proof = DeviceSessionProof {
            version: 1,
            challenge_id: challenge.id.clone(),
            device_id,
            device_key_epoch: device.key_epoch,
            audience: challenge.audience.clone(),
            challenge: challenge_bytes,
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        Fixture {
            signing_key,
            challenge,
            device,
            proof,
        }
    }

    fn signature(fixture: &Fixture) -> [u8; 64] {
        let signature: Signature = fixture.signing_key.sign(&fixture.proof.signing_bytes());
        signature.to_bytes().into()
    }

    #[test]
    fn fresh_key_bound_challenge_silently_authenticates_the_device() {
        let fixture = fixture();
        let authenticated = authorize_device_session(
            &fixture.challenge,
            &fixture.device,
            &fixture.proof,
            &signature(&fixture),
            11_000,
        )
        .unwrap();
        assert_eq!(authenticated.principal_id, fixture.device.principal_id);
        assert_eq!(authenticated.device_id, fixture.device.id);
    }

    #[test]
    fn replay_revocation_and_tampering_fail_closed() {
        let mut replay = fixture();
        replay.challenge.consumed_at_ms = Some(10_500);
        assert_eq!(
            authorize_device_session(
                &replay.challenge,
                &replay.device,
                &replay.proof,
                &signature(&replay),
                11_000,
            ),
            Err(DeviceSessionError::Consumed)
        );

        let mut revoked = fixture();
        revoked.device.revoked_at_ms = Some(10_500);
        assert_eq!(
            authorize_device_session(
                &revoked.challenge,
                &revoked.device,
                &revoked.proof,
                &signature(&revoked),
                11_000,
            ),
            Err(DeviceSessionError::DeviceRevoked)
        );

        let mut tampered = fixture();
        let signed = signature(&tampered);
        tampered.proof.expires_at_ms -= 1;
        assert_eq!(
            authorize_device_session(
                &tampered.challenge,
                &tampered.device,
                &tampered.proof,
                &signed,
                11_000,
            ),
            Err(DeviceSessionError::InvalidSignature)
        );
    }
}
