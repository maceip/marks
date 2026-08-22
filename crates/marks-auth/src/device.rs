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
}
