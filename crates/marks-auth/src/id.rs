use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fmt, ops::Deref};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum IdError {
    #[error("identifier must contain 8 to 128 base64url characters")]
    Invalid,
    #[error("ESBT site 0 is reserved for sentinels")]
    ReservedEsbtSite,
    #[error("this document has no remaining client ESBT sites")]
    EsbtSiteExhausted,
}

fn validate(value: &str) -> Result<(), IdError> {
    if !(8..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(IdError::Invalid);
    }
    Ok(())
}

macro_rules! opaque_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                validate(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Deref for $name {
            type Target = str;

            fn deref(&self) -> &Self::Target {
                self.as_str()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

opaque_id!(PrincipalId);
opaque_id!(ControllerId);
opaque_id!(DeviceId);
opaque_id!(SessionId);
opaque_id!(ScratchId);
opaque_id!(PairingId);
opaque_id!(ChallengeId);
opaque_id!(TicketId);
opaque_id!(DocumentId);

/// Room-allocated ESBT replica handle for one document.
///
/// This is the identifier encoded into ESBT ops and weights. It is never a
/// principal, session, device, or presence key. Site `0` is reserved; site `1`
/// is the room's own replica. Clients receive sites starting at `2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EsbtSiteId(u32);

impl EsbtSiteId {
    pub const SERVER: Self = Self(1);

    pub fn new(value: u32) -> Result<Self, IdError> {
        if value == 0 {
            return Err(IdError::ReservedEsbtSite);
        }
        Ok(Self(value))
    }

    pub fn as_u32(self) -> u32 {
        self.0
    }

    /// Widen to the engine's native site width without inventing identity.
    pub fn to_engine_site(self) -> u128 {
        u128::from(self.0)
    }
}

impl fmt::Display for EsbtSiteId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// Allocate the next unused client site for a document. Never returns `0` or
/// the room's server site.
pub fn allocate_esbt_site(
    occupied: impl IntoIterator<Item = EsbtSiteId>,
) -> Result<EsbtSiteId, IdError> {
    let mut used: BTreeSet<u32> = occupied.into_iter().map(EsbtSiteId::as_u32).collect();
    used.insert(0);
    used.insert(EsbtSiteId::SERVER.as_u32());
    (2..=u32::MAX)
        .find(|candidate| !used.contains(candidate))
        .map(EsbtSiteId)
        .ok_or(IdError::EsbtSiteExhausted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_accept_only_bounded_base64url_text() {
        assert!(PrincipalId::new("abcdEFGH_123-xyz").is_ok());
        assert!(PrincipalId::new("short").is_err());
        assert!(PrincipalId::new("contains a space").is_err());
        assert!(PrincipalId::new("a".repeat(129)).is_err());
    }

    #[test]
    fn esbt_sites_skip_the_sentinel_and_reuse_gaps() {
        assert_eq!(EsbtSiteId::new(0), Err(IdError::ReservedEsbtSite));
        assert_eq!(allocate_esbt_site([]).unwrap(), EsbtSiteId::new(2).unwrap());
        assert_eq!(
            allocate_esbt_site([EsbtSiteId::new(2).unwrap(), EsbtSiteId::SERVER]).unwrap(),
            EsbtSiteId::new(3).unwrap()
        );
        assert_eq!(
            allocate_esbt_site([EsbtSiteId::new(3).unwrap()]).unwrap(),
            EsbtSiteId::new(2).unwrap()
        );
        assert_eq!(EsbtSiteId::new(4).unwrap().to_engine_site(), 4);
    }
}
