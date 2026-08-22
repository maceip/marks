use crate::wire::{put_bytes, put_text, put_u8, put_u32, put_u64};
use crate::{
    ControllerId, DeviceCapabilities, DeviceId, PairingId, PendingDeviceError, PendingDeviceRecord,
    PrincipalId, ScratchAuthority, ScratchId, bearer_secret_hash, public_key_hash,
    require_live_pending_device,
};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;

const DEVICE_GRANT_DOMAIN: &[u8] = b"marks-device-grant-v1\0";
const CONTROLLER_BOOTSTRAP_DOMAIN: &[u8] = b"marks-controller-bootstrap-v1\0";
const PAIRING_SECRET_BYTES: usize = 32;
const MAX_CLOCK_SKEW_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerRecord {
    pub id: ControllerId,
    pub principal_id: PrincipalId,
    /// Canonical compressed or uncompressed SEC1 P-256 public key.
    pub public_key_sec1: Vec<u8>,
    pub epoch: u64,
    pub capabilities: DeviceCapabilities,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingRecord {
    pub id: PairingId,
    pub scratch_id: ScratchId,
    pub pending_device_id: DeviceId,
    pub pending_device_public_key_hash: [u8; 32],
    pub secret_hash: [u8; 32],
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceGrant {
    pub version: u8,
    pub principal_id: PrincipalId,
    pub controller_id: ControllerId,
    pub controller_epoch: u64,
    pub pairing_id: PairingId,
    pub scratch_id: ScratchId,
    pub pending_device_id: DeviceId,
    pub pending_device_public_key_hash: [u8; 32],
    pub capabilities: DeviceCapabilities,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

impl DeviceGrant {
    /// Canonical length-prefixed bytes signed by a phone controller. JSON is
    /// deliberately not signed: field order and number formatting must not be
    /// part of the security boundary.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(320);
        bytes.extend_from_slice(DEVICE_GRANT_DOMAIN);
        put_u8(&mut bytes, self.version);
        put_text(&mut bytes, self.principal_id.as_str());
        put_text(&mut bytes, self.controller_id.as_str());
        put_u64(&mut bytes, self.controller_epoch);
        put_text(&mut bytes, self.pairing_id.as_str());
        put_text(&mut bytes, self.scratch_id.as_str());
        put_text(&mut bytes, self.pending_device_id.as_str());
        put_bytes(&mut bytes, &self.pending_device_public_key_hash);
        put_u32(&mut bytes, self.capabilities.bits());
        put_u64(&mut bytes, self.issued_at_ms);
        put_u64(&mut bytes, self.expires_at_ms);
        bytes
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedPairing {
    pub principal_id: PrincipalId,
    pub controller_id: ControllerId,
    pub pending_device_id: DeviceId,
    pub scratch_id: ScratchId,
    pub capabilities: DeviceCapabilities,
}

/// First-phone enrollment. The phone creates one P-256 controller key and may
/// also use it as its own silent device credential. The server generates the
/// new principal only after this proof and the pending scratch claim validate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerBootstrap {
    pub version: u8,
    pub controller_id: ControllerId,
    pub controller_device_id: DeviceId,
    pub controller_public_key_hash: [u8; 32],
    pub pairing_id: PairingId,
    pub scratch_id: ScratchId,
    pub pending_device_id: DeviceId,
    pub pending_device_public_key_hash: [u8; 32],
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

impl ControllerBootstrap {
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(320);
        bytes.extend_from_slice(CONTROLLER_BOOTSTRAP_DOMAIN);
        put_u8(&mut bytes, self.version);
        put_text(&mut bytes, self.controller_id.as_str());
        put_text(&mut bytes, self.controller_device_id.as_str());
        put_bytes(&mut bytes, &self.controller_public_key_hash);
        put_text(&mut bytes, self.pairing_id.as_str());
        put_text(&mut bytes, self.scratch_id.as_str());
        put_text(&mut bytes, self.pending_device_id.as_str());
        put_bytes(&mut bytes, &self.pending_device_public_key_hash);
        put_u64(&mut bytes, self.issued_at_ms);
        put_u64(&mut bytes, self.expires_at_ms);
        bytes
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedBootstrap {
    pub controller_id: ControllerId,
    pub controller_device_id: DeviceId,
    pub controller_public_key_sec1: Vec<u8>,
    pub pending_device_id: DeviceId,
    pub scratch_id: ScratchId,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PairingError {
    #[error("unsupported device grant version")]
    UnsupportedVersion,
    #[error("pairing was already consumed")]
    Consumed,
    #[error("pairing is expired")]
    Expired,
    #[error("device grant was issued too far in the future")]
    IssuedInFuture,
    #[error("device grant outlives its pairing")]
    GrantOutlivesPairing,
    #[error("pairing secret is invalid")]
    InvalidSecret,
    #[error("controller is revoked")]
    ControllerRevoked,
    #[error("controller is not allowed to authorize devices")]
    ControllerNotAuthorized,
    #[error("controller key is invalid")]
    InvalidControllerKey,
    #[error("device grant signature is invalid")]
    InvalidSignature,
    #[error("device grant does not match the pending pairing")]
    GrantMismatch,
    #[error("pairing is not bound to this pending device")]
    PendingDeviceMismatch,
}

pub fn pairing_secret_hash(secret: &[u8]) -> [u8; 32] {
    bearer_secret_hash(secret)
}

/// Bind a two-minute pairing to the authenticated scratch and its pending key.
pub fn authorize_pairing_request(
    scratch: &ScratchAuthority,
    pending: &PendingDeviceRecord,
    now_ms: u64,
) -> Result<(), PairingError> {
    require_live_pending_device(pending, &scratch.scratch_id, now_ms).map_err(|error| match error {
        PendingDeviceError::Expired => PairingError::Expired,
        _ => PairingError::PendingDeviceMismatch,
    })
}

pub fn pairing_matches_pending(
    pairing: &PairingRecord,
    pending: &PendingDeviceRecord,
) -> Result<(), PairingError> {
    if pairing.scratch_id != pending.scratch_id
        || pairing.pending_device_id != pending.id
        || pairing.pending_device_public_key_hash != pending.public_key_hash
    {
        Err(PairingError::PendingDeviceMismatch)
    } else {
        Ok(())
    }
}

/// Validate a phone-controller approval against the exact pending QR pairing.
/// The caller must consume the pairing and enroll/claim/issue in one database
/// transaction after this returns. Rechecking `consumed_at IS NULL` in that
/// transaction is mandatory; this pure function cannot serialize two callers.
pub fn authorize_pairing(
    pairing: &PairingRecord,
    presented_secret: &[u8],
    controller: &ControllerRecord,
    grant: &DeviceGrant,
    signature_p1363: &[u8],
    now_ms: u64,
) -> Result<AuthorizedPairing, PairingError> {
    if grant.version != 1 {
        return Err(PairingError::UnsupportedVersion);
    }
    if pairing.consumed_at_ms.is_some() {
        return Err(PairingError::Consumed);
    }
    if now_ms >= pairing.expires_at_ms || now_ms >= grant.expires_at_ms {
        return Err(PairingError::Expired);
    }
    if grant.issued_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(PairingError::IssuedInFuture);
    }
    if grant.expires_at_ms > pairing.expires_at_ms {
        return Err(PairingError::GrantOutlivesPairing);
    }
    if presented_secret.len() != PAIRING_SECRET_BYTES
        || pairing
            .secret_hash
            .ct_eq(&pairing_secret_hash(presented_secret))
            .unwrap_u8()
            != 1
    {
        return Err(PairingError::InvalidSecret);
    }
    if controller.revoked_at_ms.is_some() {
        return Err(PairingError::ControllerRevoked);
    }
    if !controller
        .capabilities
        .contains(DeviceCapabilities::AUTHORIZE_DEVICES)
    {
        return Err(PairingError::ControllerNotAuthorized);
    }
    if grant.principal_id != controller.principal_id
        || grant.controller_id != controller.id
        || grant.controller_epoch != controller.epoch
        || grant.pairing_id != pairing.id
        || grant.scratch_id != pairing.scratch_id
        || grant.pending_device_id != pairing.pending_device_id
        || grant.pending_device_public_key_hash != pairing.pending_device_public_key_hash
    {
        return Err(PairingError::GrantMismatch);
    }

    let verifying_key = VerifyingKey::from_sec1_bytes(&controller.public_key_sec1)
        .map_err(|_| PairingError::InvalidControllerKey)?;
    let signature =
        Signature::from_slice(signature_p1363).map_err(|_| PairingError::InvalidSignature)?;
    verifying_key
        .verify(&grant.signing_bytes(), &signature)
        .map_err(|_| PairingError::InvalidSignature)?;

    Ok(AuthorizedPairing {
        principal_id: grant.principal_id.clone(),
        controller_id: grant.controller_id.clone(),
        pending_device_id: grant.pending_device_id.clone(),
        scratch_id: grant.scratch_id.clone(),
        capabilities: grant.capabilities,
    })
}

/// Validate creation of the first durable principal/controller from a QR
/// pairing. The caller must generate the principal, consume the pairing, claim
/// the scratch workspace, enroll both devices, and issue sessions in one
/// serializable database transaction.
pub fn authorize_controller_bootstrap(
    pairing: &PairingRecord,
    presented_secret: &[u8],
    bootstrap: &ControllerBootstrap,
    controller_public_key_sec1: &[u8],
    signature_p1363: &[u8],
    now_ms: u64,
) -> Result<AuthorizedBootstrap, PairingError> {
    if bootstrap.version != 1 {
        return Err(PairingError::UnsupportedVersion);
    }
    if pairing.consumed_at_ms.is_some() {
        return Err(PairingError::Consumed);
    }
    if now_ms >= pairing.expires_at_ms || now_ms >= bootstrap.expires_at_ms {
        return Err(PairingError::Expired);
    }
    if bootstrap.issued_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(PairingError::IssuedInFuture);
    }
    if bootstrap.expires_at_ms > pairing.expires_at_ms {
        return Err(PairingError::GrantOutlivesPairing);
    }
    if presented_secret.len() != PAIRING_SECRET_BYTES
        || pairing
            .secret_hash
            .ct_eq(&pairing_secret_hash(presented_secret))
            .unwrap_u8()
            != 1
    {
        return Err(PairingError::InvalidSecret);
    }
    if bootstrap.pairing_id != pairing.id
        || bootstrap.scratch_id != pairing.scratch_id
        || bootstrap.pending_device_id != pairing.pending_device_id
        || bootstrap.pending_device_public_key_hash != pairing.pending_device_public_key_hash
        || bootstrap.controller_device_id == pairing.pending_device_id
        || bootstrap.controller_public_key_hash != public_key_hash(controller_public_key_sec1)
    {
        return Err(PairingError::GrantMismatch);
    }

    let verifying_key = VerifyingKey::from_sec1_bytes(controller_public_key_sec1)
        .map_err(|_| PairingError::InvalidControllerKey)?;
    let signature =
        Signature::from_slice(signature_p1363).map_err(|_| PairingError::InvalidSignature)?;
    verifying_key
        .verify(&bootstrap.signing_bytes(), &signature)
        .map_err(|_| PairingError::InvalidSignature)?;

    Ok(AuthorizedBootstrap {
        controller_id: bootstrap.controller_id.clone(),
        controller_device_id: bootstrap.controller_device_id.clone(),
        controller_public_key_sec1: controller_public_key_sec1.to_vec(),
        pending_device_id: bootstrap.pending_device_id.clone(),
        scratch_id: bootstrap.scratch_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use rand_core::OsRng;
    use std::fmt::Write;

    fn principal(value: &str) -> PrincipalId {
        PrincipalId::new(value).unwrap()
    }

    fn controller_id(value: &str) -> ControllerId {
        ControllerId::new(value).unwrap()
    }

    fn pairing_id(value: &str) -> PairingId {
        PairingId::new(value).unwrap()
    }

    fn scratch_id(value: &str) -> ScratchId {
        ScratchId::new(value).unwrap()
    }

    fn device_id(value: &str) -> DeviceId {
        DeviceId::new(value).unwrap()
    }

    struct Fixture {
        signing_key: SigningKey,
        controller: ControllerRecord,
        pairing: PairingRecord,
        grant: DeviceGrant,
        secret: [u8; 32],
    }

    fn fixture() -> Fixture {
        let signing_key = SigningKey::random(&mut OsRng);
        let controller_public = signing_key.verifying_key().to_encoded_point(true);
        let secret = [7_u8; 32];
        let pending_device_key = [4_u8; 65];
        let key_hash = public_key_hash(&pending_device_key);

        let controller = ControllerRecord {
            id: controller_id("controller_123"),
            principal_id: principal("principal_1234"),
            public_key_sec1: controller_public.as_bytes().to_vec(),
            epoch: 8,
            capabilities: DeviceCapabilities::CONTROLLER,
            revoked_at_ms: None,
        };
        let pairing = PairingRecord {
            id: pairing_id("pairing_123456"),
            scratch_id: scratch_id("scratch_123456"),
            pending_device_id: device_id("device_1234567"),
            pending_device_public_key_hash: key_hash,
            secret_hash: pairing_secret_hash(&secret),
            expires_at_ms: 20_000,
            consumed_at_ms: None,
        };
        let grant = DeviceGrant {
            version: 1,
            principal_id: controller.principal_id.clone(),
            controller_id: controller.id.clone(),
            controller_epoch: controller.epoch,
            pairing_id: pairing.id.clone(),
            scratch_id: pairing.scratch_id.clone(),
            pending_device_id: pairing.pending_device_id.clone(),
            pending_device_public_key_hash: pairing.pending_device_public_key_hash,
            capabilities: DeviceCapabilities::MEMBER,
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        Fixture {
            signing_key,
            controller,
            pairing,
            grant,
            secret,
        }
    }

    fn signed_bytes(fixture: &Fixture) -> [u8; 64] {
        let signature: Signature = fixture.signing_key.sign(&fixture.grant.signing_bytes());
        signature.to_bytes().into()
    }

    #[test]
    fn device_grant_bytes_match_the_browser_golden_fixture() {
        let grant = DeviceGrant {
            version: 1,
            principal_id: principal("principal_1234"),
            controller_id: controller_id("controller_123"),
            controller_epoch: 8,
            pairing_id: pairing_id("pairing_123456"),
            scratch_id: scratch_id("scratch_123456"),
            pending_device_id: device_id("device_1234567"),
            pending_device_public_key_hash: std::array::from_fn(|index| index as u8),
            capabilities: DeviceCapabilities::MEMBER,
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        let mut encoded = String::new();
        for byte in grant.signing_bytes() {
            write!(&mut encoded, "{byte:02x}").unwrap();
        }
        assert_eq!(
            encoded,
            "6d61726b732d6465766963652d6772616e742d763100010000000e7072696e636970616c5f313233340000000e636f6e74726f6c6c65725f31323300000000000000080000000e70616972696e675f3132333435360000000e736372617463685f3132333435360000000e6465766963655f3132333435363700000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0000000100000000000027100000000000004a38"
        );
    }

    #[test]
    fn exact_fresh_controller_grant_authorizes_the_pending_device() {
        let fixture = fixture();
        let signature = signed_bytes(&fixture);
        let authorized = authorize_pairing(
            &fixture.pairing,
            &fixture.secret,
            &fixture.controller,
            &fixture.grant,
            &signature,
            11_000,
        )
        .unwrap();

        assert_eq!(authorized.principal_id, fixture.controller.principal_id);
        assert_eq!(
            authorized.pending_device_id,
            fixture.pairing.pending_device_id
        );
        assert_eq!(authorized.scratch_id, fixture.pairing.scratch_id);
    }

    #[test]
    fn secret_device_replay_expiry_and_revocation_fail_closed() {
        let mut case = fixture();
        let signature = signed_bytes(&case);

        assert_eq!(
            authorize_pairing(
                &case.pairing,
                &[9_u8; 32],
                &case.controller,
                &case.grant,
                &signature,
                11_000,
            ),
            Err(PairingError::InvalidSecret)
        );

        case.grant.pending_device_id = device_id("device_tampered");
        assert_eq!(
            authorize_pairing(
                &case.pairing,
                &case.secret,
                &case.controller,
                &case.grant,
                &signature,
                11_000,
            ),
            Err(PairingError::GrantMismatch)
        );

        let mut replay_case = fixture();
        replay_case.pairing.consumed_at_ms = Some(11_000);
        let replay_signature = signed_bytes(&replay_case);
        assert_eq!(
            authorize_pairing(
                &replay_case.pairing,
                &replay_case.secret,
                &replay_case.controller,
                &replay_case.grant,
                &replay_signature,
                12_000,
            ),
            Err(PairingError::Consumed)
        );

        let mut revoked_case = fixture();
        revoked_case.controller.revoked_at_ms = Some(10_500);
        let revoked_signature = signed_bytes(&revoked_case);
        assert_eq!(
            authorize_pairing(
                &revoked_case.pairing,
                &revoked_case.secret,
                &revoked_case.controller,
                &revoked_case.grant,
                &revoked_signature,
                11_000,
            ),
            Err(PairingError::ControllerRevoked)
        );

        let expired_case = fixture();
        let expired_signature = signed_bytes(&expired_case);
        assert_eq!(
            authorize_pairing(
                &expired_case.pairing,
                &expired_case.secret,
                &expired_case.controller,
                &expired_case.grant,
                &expired_signature,
                20_000,
            ),
            Err(PairingError::Expired)
        );
    }

    #[test]
    fn a_member_device_cannot_authorize_another_device() {
        let mut fixture = fixture();
        fixture.controller.capabilities = DeviceCapabilities::MEMBER;
        let signature = signed_bytes(&fixture);
        assert_eq!(
            authorize_pairing(
                &fixture.pairing,
                &fixture.secret,
                &fixture.controller,
                &fixture.grant,
                &signature,
                11_000,
            ),
            Err(PairingError::ControllerNotAuthorized)
        );
    }

    #[test]
    fn changing_a_signed_field_invalidates_the_signature() {
        let mut fixture = fixture();
        let signature = signed_bytes(&fixture);
        fixture.grant.capabilities = DeviceCapabilities::CONTROLLER;

        assert_eq!(
            authorize_pairing(
                &fixture.pairing,
                &fixture.secret,
                &fixture.controller,
                &fixture.grant,
                &signature,
                11_000,
            ),
            Err(PairingError::InvalidSignature)
        );
    }

    #[test]
    fn first_phone_bootstraps_a_controller_without_choosing_the_principal() {
        let fixture = fixture();
        let phone_key = SigningKey::random(&mut OsRng);
        let phone_public = phone_key.verifying_key().to_encoded_point(true);
        let bootstrap = ControllerBootstrap {
            version: 1,
            controller_id: controller_id("controller_phone1"),
            controller_device_id: device_id("device_phone_123"),
            controller_public_key_hash: public_key_hash(phone_public.as_bytes()),
            pairing_id: fixture.pairing.id.clone(),
            scratch_id: fixture.pairing.scratch_id.clone(),
            pending_device_id: fixture.pairing.pending_device_id.clone(),
            pending_device_public_key_hash: fixture.pairing.pending_device_public_key_hash,
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        let signature: Signature = phone_key.sign(&bootstrap.signing_bytes());
        let signature: [u8; 64] = signature.to_bytes().into();

        let authorized = authorize_controller_bootstrap(
            &fixture.pairing,
            &fixture.secret,
            &bootstrap,
            phone_public.as_bytes(),
            &signature,
            11_000,
        )
        .unwrap();

        assert_eq!(authorized.controller_id, bootstrap.controller_id);
        assert_eq!(
            authorized.controller_device_id,
            bootstrap.controller_device_id
        );
        assert_eq!(
            authorized.pending_device_id,
            fixture.pairing.pending_device_id
        );
        assert_eq!(authorized.scratch_id, fixture.pairing.scratch_id);
    }

    #[test]
    fn bootstrap_rejects_a_substituted_controller_key() {
        let fixture = fixture();
        let phone_key = SigningKey::random(&mut OsRng);
        let phone_public = phone_key.verifying_key().to_encoded_point(true);
        let bootstrap = ControllerBootstrap {
            version: 1,
            controller_id: controller_id("controller_phone1"),
            controller_device_id: device_id("device_phone_123"),
            controller_public_key_hash: public_key_hash(phone_public.as_bytes()),
            pairing_id: fixture.pairing.id.clone(),
            scratch_id: fixture.pairing.scratch_id.clone(),
            pending_device_id: fixture.pairing.pending_device_id.clone(),
            pending_device_public_key_hash: fixture.pairing.pending_device_public_key_hash,
            issued_at_ms: 10_000,
            expires_at_ms: 19_000,
        };
        let signature: Signature = phone_key.sign(&bootstrap.signing_bytes());
        let signature: [u8; 64] = signature.to_bytes().into();
        let attacker_key = SigningKey::random(&mut OsRng);
        let attacker_public = attacker_key.verifying_key().to_encoded_point(true);

        assert_eq!(
            authorize_controller_bootstrap(
                &fixture.pairing,
                &fixture.secret,
                &bootstrap,
                attacker_public.as_bytes(),
                &signature,
                11_000,
            ),
            Err(PairingError::GrantMismatch)
        );
    }
}
