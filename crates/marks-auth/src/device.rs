use crate::{DeviceId, PrincipalId};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceCapabilities(u32);

impl DeviceCapabilities {
    pub const DOCUMENTS: u32 = 1 << 0;
    pub const AUTHORIZE_DEVICES: u32 = 1 << 1;
    pub const REVOKE_DEVICES: u32 = 1 << 2;
    const KNOWN: u32 = Self::DOCUMENTS | Self::AUTHORIZE_DEVICES | Self::REVOKE_DEVICES;

    pub const MEMBER: Self = Self(Self::DOCUMENTS);
    pub const CONTROLLER: Self = Self(Self::KNOWN);

    pub fn from_bits(bits: u32) -> Result<Self, CapabilityError> {
        if bits & !Self::KNOWN == 0 {
            Ok(Self(bits))
        } else {
            Err(CapabilityError::UnknownBits)
        }
    }

    pub fn bits(self) -> u32 {
        self.0
    }

    pub fn contains(self, capability: u32) -> bool {
        self.0 & capability == capability
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DeviceError {
    #[error("device is revoked")]
    Revoked,
    #[error("device is not allowed to revoke another device")]
    NotAuthorized,
    #[error("devices belong to different principals")]
    PrincipalMismatch,
}

impl Serialize for DeviceCapabilities {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u32(self.bits())
    }
}

impl<'de> Deserialize<'de> for DeviceCapabilities {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let bits = u32::deserialize(deserializer)?;
        Self::from_bits(bits).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CapabilityError {
    #[error("device capabilities contain unknown bits")]
    UnknownBits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRecord {
    pub id: DeviceId,
    pub principal_id: PrincipalId,
    /// Canonical compressed or uncompressed SEC1 P-256 public key.
    pub public_key_sec1: Vec<u8>,
    pub key_epoch: u64,
    pub capabilities: DeviceCapabilities,
    pub revoked_at_ms: Option<u64>,
}

/// A controller with `REVOKE_DEVICES` may revoke any device on its principal.
pub fn authorize_revoke_device(
    actor: &DeviceRecord,
    target: &DeviceRecord,
) -> Result<(), DeviceError> {
    if actor.revoked_at_ms.is_some() {
        return Err(DeviceError::Revoked);
    }
    if actor.principal_id != target.principal_id {
        return Err(DeviceError::PrincipalMismatch);
    }
    if !actor
        .capabilities
        .contains(DeviceCapabilities::REVOKE_DEVICES)
    {
        return Err(DeviceError::NotAuthorized);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_capability_bits_are_rejected() {
        assert_eq!(
            DeviceCapabilities::from_bits(1 << 31),
            Err(CapabilityError::UnknownBits)
        );
        assert_eq!(
            DeviceCapabilities::from_bits(DeviceCapabilities::CONTROLLER.bits()),
            Ok(DeviceCapabilities::CONTROLLER)
        );
    }

    #[test]
    fn only_a_controller_can_revoke_a_device_on_its_principal() {
        let principal = PrincipalId::new("principal_1234").unwrap();
        let controller = DeviceRecord {
            id: DeviceId::new("device_phone_123").unwrap(),
            principal_id: principal.clone(),
            public_key_sec1: vec![4; 33],
            key_epoch: 1,
            capabilities: DeviceCapabilities::CONTROLLER,
            revoked_at_ms: None,
        };
        let member = DeviceRecord {
            id: DeviceId::new("device_1234567").unwrap(),
            principal_id: principal,
            public_key_sec1: vec![4; 33],
            key_epoch: 1,
            capabilities: DeviceCapabilities::MEMBER,
            revoked_at_ms: None,
        };
        authorize_revoke_device(&controller, &member).unwrap();
        assert_eq!(
            authorize_revoke_device(&member, &controller),
            Err(DeviceError::NotAuthorized)
        );
    }
}
