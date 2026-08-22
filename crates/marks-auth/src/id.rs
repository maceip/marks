use serde::{Deserialize, Serialize};
use std::{fmt, ops::Deref};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum IdError {
    #[error("identifier must contain 8 to 128 base64url characters")]
    Invalid,
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
opaque_id!(SiteId);

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
}
