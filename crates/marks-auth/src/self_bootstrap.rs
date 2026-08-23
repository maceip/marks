//! Single-device promotion: the scratch workspace's own pending device key
//! becomes the first controller.
//!
//! The QR pairing rail assumes a second device is present to scan. A visitor
//! whose only device is the phone (or the laptop) has nothing to link to, so
//! this rail lets the pending key already bound to the live scratch sign a
//! self-bootstrap statement and be promoted in place. It grants no authority
//! that the pairing rail does not: a caller holding the scratch capability
//! and the pending private key could always mint a pairing and consume it
//! itself. This statement removes the ceremony, not a check.

use crate::wire::{put_bytes, put_text, put_u8, put_u64};
use crate::{
    ControllerId, DeviceId, PendingDeviceRecord, ScratchAuthority, ScratchId,
    require_live_pending_device,
};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const SELF_BOOTSTRAP_DOMAIN: &[u8] = b"marks-self-bootstrap-v1\0";
const MAX_CLOCK_SKEW_MS: u64 = 60_000;

/// A signed self-bootstrap statement must not outlive the window a QR pairing
/// would have had. Two minutes, matching the pairing TTL.
pub const SELF_BOOTSTRAP_WINDOW_MS: u64 = 2 * 60 * 1000;

/// Single-device enrollment. The browser signs with the pending device key
/// that is already bound to the live scratch workspace; the same key is
/// promoted to controller plus controller-capable device. The server, never
/// the client, generates the new principal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelfBootstrap {
    pub version: u8,
    pub controller_id: ControllerId,
    pub scratch_id: ScratchId,
    pub device_id: DeviceId,
    pub device_public_key_hash: [u8; 32],
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

impl SelfBootstrap {
    /// Canonical length-prefixed bytes signed by the pending device key. JSON
    /// is deliberately not signed.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(192);
        bytes.extend_from_slice(SELF_BOOTSTRAP_DOMAIN);
        put_u8(&mut bytes, self.version);
        put_text(&mut bytes, self.controller_id.as_str());
        put_text(&mut bytes, self.scratch_id.as_str());
        put_text(&mut bytes, self.device_id.as_str());
        put_bytes(&mut bytes, &self.device_public_key_hash);
        put_u64(&mut bytes, self.issued_at_ms);
        put_u64(&mut bytes, self.expires_at_ms);
        bytes
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedSelfBootstrap {
    pub controller_id: ControllerId,
    pub device_id: DeviceId,
    pub scratch_id: ScratchId,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SelfBootstrapError {
    #[error("unsupported self-bootstrap version")]
    UnsupportedVersion,
    #[error("self-bootstrap statement is expired")]
    Expired,
    #[error("self-bootstrap statement was issued too far in the future")]
    IssuedInFuture,
    #[error("self-bootstrap statement outlives its window")]
    WindowTooLong,
    #[error("pending device is not live for this scratch workspace")]
    PendingDeviceInvalid,
    #[error("self-bootstrap statement does not match the pending device")]
    StatementMismatch,
    #[error("pending device key is invalid")]
    InvalidDeviceKey,
    #[error("self-bootstrap signature is invalid")]
    InvalidSignature,
}

/// Validate promotion of a live scratch workspace by its own pending device
/// key, with no pairing involved. The caller must generate the principal,
/// promote the key as controller plus device, claim the scratch documents,
/// and issue the session in one serializable transaction; the scratch-claim
/// row update (`claimed_by IS NULL`) is the one-use anchor that serializes a
/// race against a concurrent pairing promotion.
pub fn authorize_self_bootstrap(
    scratch: &ScratchAuthority,
    pending: &PendingDeviceRecord,
    statement: &SelfBootstrap,
    signature_p1363: &[u8],
    now_ms: u64,
) -> Result<AuthorizedSelfBootstrap, SelfBootstrapError> {
    if statement.version != 1 {
        return Err(SelfBootstrapError::UnsupportedVersion);
    }
    if now_ms >= statement.expires_at_ms {
        return Err(SelfBootstrapError::Expired);
    }
    if statement.issued_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(SelfBootstrapError::IssuedInFuture);
    }
    if statement.expires_at_ms
        > statement
            .issued_at_ms
            .saturating_add(SELF_BOOTSTRAP_WINDOW_MS)
    {
        return Err(SelfBootstrapError::WindowTooLong);
    }
    require_live_pending_device(pending, &scratch.scratch_id, now_ms)
        .map_err(|_| SelfBootstrapError::PendingDeviceInvalid)?;
    if statement.scratch_id != scratch.scratch_id
        || statement.device_id != pending.id
        || statement.device_public_key_hash != pending.public_key_hash
    {
        return Err(SelfBootstrapError::StatementMismatch);
    }

    let verifying_key = VerifyingKey::from_sec1_bytes(&pending.public_key_sec1)
        .map_err(|_| SelfBootstrapError::InvalidDeviceKey)?;
    let signature =
        Signature::from_slice(signature_p1363).map_err(|_| SelfBootstrapError::InvalidSignature)?;
    verifying_key
        .verify(&statement.signing_bytes(), &signature)
        .map_err(|_| SelfBootstrapError::InvalidSignature)?;

    Ok(AuthorizedSelfBootstrap {
        controller_id: statement.controller_id.clone(),
        device_id: statement.device_id.clone(),
        scratch_id: statement.scratch_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bind_pending_device;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use rand_core::OsRng;
    use std::fmt::Write;

    struct Fixture {
        signing_key: SigningKey,
        scratch: ScratchAuthority,
        pending: PendingDeviceRecord,
        statement: SelfBootstrap,
    }

    fn fixture() -> Fixture {
        let signing_key = SigningKey::random(&mut OsRng);
        let public = signing_key.verifying_key().to_encoded_point(false);
        let scratch = ScratchAuthority {
            scratch_id: ScratchId::new("scratch_123456").unwrap(),
        };
        let pending = bind_pending_device(
            &scratch,
            DeviceId::new("device_1234567").unwrap(),
            public.as_bytes(),
            1_000,
            86_400_000,
        )
        .unwrap();
        let statement = SelfBootstrap {
            version: 1,
            controller_id: ControllerId::new("controller_123").unwrap(),
            scratch_id: scratch.scratch_id.clone(),
            device_id: pending.id.clone(),
            device_public_key_hash: pending.public_key_hash,
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        Fixture {
            signing_key,
            scratch,
            pending,
            statement,
        }
    }

    fn signed(fixture: &Fixture) -> [u8; 64] {
        let signature: Signature = fixture.signing_key.sign(&fixture.statement.signing_bytes());
        signature.to_bytes().into()
    }

    #[test]
    fn self_bootstrap_bytes_match_the_browser_golden_fixture() {
        let statement = SelfBootstrap {
            version: 1,
            controller_id: ControllerId::new("controller_123").unwrap(),
            scratch_id: ScratchId::new("scratch_123456").unwrap(),
            device_id: DeviceId::new("device_1234567").unwrap(),
            device_public_key_hash: std::array::from_fn(|index| index as u8),
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        let mut encoded = String::new();
        for byte in statement.signing_bytes() {
            write!(&mut encoded, "{byte:02x}").unwrap();
        }
        assert_eq!(
            encoded,
            "6d61726b732d73656c662d626f6f7473747261702d763100010000000e636f6e74726f6c6c65725f3132330000000e736372617463685f3132333435360000000e6465766963655f3132333435363700000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00000000000027100000000000004a38"
        );
    }

    #[test]
    fn the_pending_key_bound_to_the_scratch_promotes_itself() {
        let fixture = fixture();
        let signature = signed(&fixture);
        let authorized = authorize_self_bootstrap(
            &fixture.scratch,
            &fixture.pending,
            &fixture.statement,
            &signature,
            11_000,
        )
        .unwrap();

        assert_eq!(authorized.controller_id, fixture.statement.controller_id);
        assert_eq!(authorized.device_id, fixture.pending.id);
        assert_eq!(authorized.scratch_id, fixture.scratch.scratch_id);
    }

    #[test]
    fn expiry_skew_window_and_version_fail_closed() {
        let fixture = fixture();
        let signature = signed(&fixture);

        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &fixture.statement,
                &signature,
                19_000,
            ),
            Err(SelfBootstrapError::Expired)
        );

        let mut future = fixture.statement.clone();
        future.issued_at_ms = 200_000;
        future.expires_at_ms = 210_000;
        let future_signature: Signature = fixture.signing_key.sign(&future.signing_bytes());
        let future_signature: [u8; 64] = future_signature.to_bytes().into();
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &future,
                &future_signature,
                11_000,
            ),
            Err(SelfBootstrapError::IssuedInFuture)
        );

        let mut long = fixture.statement.clone();
        long.expires_at_ms = long.issued_at_ms + SELF_BOOTSTRAP_WINDOW_MS + 1;
        let long_signature: Signature = fixture.signing_key.sign(&long.signing_bytes());
        let long_signature: [u8; 64] = long_signature.to_bytes().into();
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &long,
                &long_signature,
                11_000,
            ),
            Err(SelfBootstrapError::WindowTooLong)
        );

        let mut version = fixture.statement.clone();
        version.version = 2;
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &version,
                &signature,
                11_000,
            ),
            Err(SelfBootstrapError::UnsupportedVersion)
        );
    }

    #[test]
    fn a_statement_for_another_scratch_device_or_key_is_rejected() {
        let fixture = fixture();
        let signature = signed(&fixture);

        let other_scratch = ScratchAuthority {
            scratch_id: ScratchId::new("scratch_other1").unwrap(),
        };
        assert_eq!(
            authorize_self_bootstrap(
                &other_scratch,
                &fixture.pending,
                &fixture.statement,
                &signature,
                11_000,
            ),
            Err(SelfBootstrapError::PendingDeviceInvalid)
        );

        let mut wrong_device = fixture.statement.clone();
        wrong_device.device_id = DeviceId::new("device_tampered").unwrap();
        let wrong_signature: Signature = fixture.signing_key.sign(&wrong_device.signing_bytes());
        let wrong_signature: [u8; 64] = wrong_signature.to_bytes().into();
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &wrong_device,
                &wrong_signature,
                11_000,
            ),
            Err(SelfBootstrapError::StatementMismatch)
        );

        let mut wrong_hash = fixture.statement.clone();
        wrong_hash.device_public_key_hash = [9_u8; 32];
        let hash_signature: Signature = fixture.signing_key.sign(&wrong_hash.signing_bytes());
        let hash_signature: [u8; 64] = hash_signature.to_bytes().into();
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &wrong_hash,
                &hash_signature,
                11_000,
            ),
            Err(SelfBootstrapError::StatementMismatch)
        );
    }

    #[test]
    fn only_the_bound_pending_key_may_sign() {
        let fixture = fixture();
        let attacker = SigningKey::random(&mut OsRng);
        let forged: Signature = attacker.sign(&fixture.statement.signing_bytes());
        let forged: [u8; 64] = forged.to_bytes().into();
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &fixture.statement,
                &forged,
                11_000,
            ),
            Err(SelfBootstrapError::InvalidSignature)
        );

        let mut tampered = fixture.statement.clone();
        let signature = signed(&fixture);
        tampered.expires_at_ms -= 1;
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &tampered,
                &signature,
                11_000,
            ),
            Err(SelfBootstrapError::InvalidSignature)
        );
    }

    #[test]
    fn an_expired_pending_device_cannot_promote_itself() {
        let fixture = fixture();
        let signature = signed(&fixture);
        assert_eq!(
            authorize_self_bootstrap(
                &fixture.scratch,
                &fixture.pending,
                &fixture.statement,
                &signature,
                // Within the statement window but past the pending TTL.
                fixture.pending.expires_at_ms.max(19_000) - 1,
            ),
            Err(SelfBootstrapError::Expired)
        );
        let mut short_lived = fixture;
        short_lived.pending.expires_at_ms = 10_500;
        let signature = signed(&short_lived);
        assert_eq!(
            authorize_self_bootstrap(
                &short_lived.scratch,
                &short_lived.pending,
                &short_lived.statement,
                &signature,
                11_000,
            ),
            Err(SelfBootstrapError::PendingDeviceInvalid)
        );
    }
}
