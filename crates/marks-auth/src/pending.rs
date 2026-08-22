use crate::{DeviceId, ScratchAuthority, ScratchId, public_key_hash};
use p256::ecdsa::VerifyingKey;
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDeviceRecord {
    pub id: DeviceId,
    pub scratch_id: ScratchId,
    pub public_key_sec1: Vec<u8>,
    pub public_key_hash: [u8; 32],
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PendingDeviceError {
    #[error("pending device public key is not a valid P-256 SEC1 point")]
    InvalidPublicKey,
    #[error("pending device public key digest does not match the key")]
    PublicKeyMismatch,
    #[error("pending device is not bound to this scratch workspace")]
    ScratchMismatch,
    #[error("pending device is expired")]
    Expired,
}

/// Bind the browser's pending P-256 key to an authenticated scratch workspace.
/// Generating the key does not promote the workspace.
pub fn bind_pending_device(
    scratch: &ScratchAuthority,
    device_id: DeviceId,
    public_key_sec1: &[u8],
    now_ms: u64,
    ttl_ms: u64,
) -> Result<PendingDeviceRecord, PendingDeviceError> {
    VerifyingKey::from_sec1_bytes(public_key_sec1)
        .map_err(|_| PendingDeviceError::InvalidPublicKey)?;
    Ok(PendingDeviceRecord {
        id: device_id,
        scratch_id: scratch.scratch_id.clone(),
        public_key_sec1: public_key_sec1.to_vec(),
        public_key_hash: public_key_hash(public_key_sec1),
        expires_at_ms: now_ms.saturating_add(ttl_ms),
    })
}

pub fn require_live_pending_device(
    pending: &PendingDeviceRecord,
    scratch_id: &ScratchId,
    now_ms: u64,
) -> Result<(), PendingDeviceError> {
    if pending.public_key_hash != public_key_hash(&pending.public_key_sec1) {
        return Err(PendingDeviceError::PublicKeyMismatch);
    }
    if VerifyingKey::from_sec1_bytes(&pending.public_key_sec1).is_err() {
        return Err(PendingDeviceError::InvalidPublicKey);
    }
    if &pending.scratch_id != scratch_id {
        return Err(PendingDeviceError::ScratchMismatch);
    }
    if now_ms >= pending.expires_at_ms {
        return Err(PendingDeviceError::Expired);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::SigningKey;
    use rand_core::OsRng;

    #[test]
    fn a_valid_p256_key_binds_to_the_scratch_workspace() {
        let key = SigningKey::random(&mut OsRng);
        let public = key.verifying_key().to_encoded_point(true);
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

        assert_eq!(pending.scratch_id, scratch.scratch_id);
        assert_eq!(pending.public_key_hash, public_key_hash(public.as_bytes()));
        require_live_pending_device(&pending, &scratch.scratch_id, 2_000).unwrap();
    }

    #[test]
    fn garbage_keys_and_expired_rows_fail_closed() {
        let scratch = ScratchAuthority {
            scratch_id: ScratchId::new("scratch_123456").unwrap(),
        };
        assert_eq!(
            bind_pending_device(
                &scratch,
                DeviceId::new("device_1234567").unwrap(),
                &[1, 2, 3],
                1_000,
                10,
            ),
            Err(PendingDeviceError::InvalidPublicKey)
        );

        let key = SigningKey::random(&mut OsRng);
        let public = key.verifying_key().to_encoded_point(true);
        let pending = bind_pending_device(
            &scratch,
            DeviceId::new("device_1234567").unwrap(),
            public.as_bytes(),
            1_000,
            10,
        )
        .unwrap();
        assert_eq!(
            require_live_pending_device(&pending, &scratch.scratch_id, 1_010),
            Err(PendingDeviceError::Expired)
        );
    }
}
