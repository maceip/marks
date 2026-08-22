use crate::{DeviceRecord, PrincipalId, SessionId, bearer_secret_hash};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;

const CSRF_DOMAIN: &[u8] = b"marks-csrf-v1\0";

const SESSION_SECRET_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: SessionId,
    pub principal_id: PrincipalId,
    pub device_id: crate::DeviceId,
    pub secret_hash: [u8; 32],
    pub expires_at_ms: u64,
    pub revoked_at_ms: Option<u64>,
}

/// A session that has passed cookie-secret, expiry, principal, device, and
/// revocation validation. Downstream authorization APIs accept this type so a
/// raw database row cannot accidentally be treated as authenticated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedSession {
    id: SessionId,
    principal_id: PrincipalId,
    device_id: crate::DeviceId,
    expires_at_ms: u64,
}

impl AuthenticatedSession {
    pub fn id(&self) -> &SessionId {
        &self.id
    }

    pub fn principal_id(&self) -> &PrincipalId {
        &self.principal_id
    }

    pub fn device_id(&self) -> &crate::DeviceId {
        &self.device_id
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("session is revoked")]
    Revoked,
    #[error("session is expired")]
    Expired,
    #[error("session principal does not match the enrolled device")]
    PrincipalMismatch,
    #[error("session device does not match the enrolled device")]
    DeviceMismatch,
    #[error("device is revoked")]
    DeviceRevoked,
    #[error("session secret is invalid")]
    InvalidSecret,
    #[error("session CSRF token is invalid")]
    InvalidCsrf,
}

pub fn session_secret_hash(secret: &[u8]) -> [u8; 32] {
    bearer_secret_hash(secret)
}

/// Readable same-origin CSRF token derived from the session secret. This is
/// not the cookie; presenting it does not authenticate a session.
pub fn session_csrf_token(session_secret: &[u8]) -> Result<[u8; 32], SessionError> {
    if session_secret.len() != SESSION_SECRET_BYTES {
        return Err(SessionError::InvalidSecret);
    }
    let mut digest = Sha256::new();
    digest.update(CSRF_DOMAIN);
    digest.update(session_secret);
    Ok(digest.finalize().into())
}

pub fn validate_session_csrf(session_secret: &[u8], presented: &[u8]) -> Result<(), SessionError> {
    let expected = session_csrf_token(session_secret)?;
    if presented.len() != SESSION_SECRET_BYTES || expected.ct_eq(presented).unwrap_u8() != 1 {
        Err(SessionError::InvalidCsrf)
    } else {
        Ok(())
    }
}

pub fn validate_session(
    session: &SessionRecord,
    presented_secret: &[u8],
    device: &DeviceRecord,
    now_ms: u64,
) -> Result<AuthenticatedSession, SessionError> {
    if presented_secret.len() != SESSION_SECRET_BYTES
        || session
            .secret_hash
            .ct_eq(&session_secret_hash(presented_secret))
            .unwrap_u8()
            != 1
    {
        return Err(SessionError::InvalidSecret);
    }
    if session.revoked_at_ms.is_some() {
        return Err(SessionError::Revoked);
    }
    if now_ms >= session.expires_at_ms {
        return Err(SessionError::Expired);
    }
    if session.device_id != device.id {
        return Err(SessionError::DeviceMismatch);
    }
    if session.principal_id != device.principal_id {
        return Err(SessionError::PrincipalMismatch);
    }
    if device.revoked_at_ms.is_some() {
        return Err(SessionError::DeviceRevoked);
    }
    Ok(AuthenticatedSession {
        id: session.id.clone(),
        principal_id: session.principal_id.clone(),
        device_id: session.device_id.clone(),
        expires_at_ms: session.expires_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeviceCapabilities, DeviceId};

    fn id<T>(value: &str, constructor: impl FnOnce(String) -> Result<T, crate::id::IdError>) -> T {
        constructor(value.to_owned()).unwrap()
    }

    #[test]
    fn expiry_and_revocation_are_hard_failures() {
        let principal = id("principal_123", PrincipalId::new);
        let secret = [7_u8; 32];
        let device = DeviceRecord {
            id: id("device_12345", DeviceId::new),
            principal_id: principal.clone(),
            public_key_sec1: vec![4; 33],
            key_epoch: 1,
            capabilities: DeviceCapabilities::MEMBER,
            revoked_at_ms: None,
        };
        let session = SessionRecord {
            id: id("session_12345", SessionId::new),
            principal_id: principal.clone(),
            device_id: device.id.clone(),
            secret_hash: session_secret_hash(&secret),
            expires_at_ms: 100,
            revoked_at_ms: None,
        };

        let authenticated = validate_session(&session, &secret, &device, 99).unwrap();
        assert_eq!(authenticated.id(), &session.id);
        assert_eq!(authenticated.principal_id(), &principal);
        assert_eq!(authenticated.device_id(), &device.id);
        assert_eq!(
            validate_session(&session, &secret, &device, 100),
            Err(SessionError::Expired)
        );
        let mut revoked_device = device.clone();
        revoked_device.revoked_at_ms = Some(90);
        assert_eq!(
            validate_session(&session, &secret, &revoked_device, 99),
            Err(SessionError::DeviceRevoked)
        );
        assert_eq!(
            validate_session(&session, &[8_u8; 32], &device, 99),
            Err(SessionError::InvalidSecret)
        );
    }

    #[test]
    fn session_is_bound_to_one_principal_and_device() {
        let secret = [7_u8; 32];
        let principal = id("principal_123", PrincipalId::new);
        let session = SessionRecord {
            id: id("session_12345", SessionId::new),
            principal_id: principal.clone(),
            device_id: id("device_12345", DeviceId::new),
            secret_hash: session_secret_hash(&secret),
            expires_at_ms: 100,
            revoked_at_ms: None,
        };
        let other_device = DeviceRecord {
            id: id("device_other1", DeviceId::new),
            principal_id: principal,
            public_key_sec1: vec![4; 33],
            key_epoch: 1,
            capabilities: DeviceCapabilities::MEMBER,
            revoked_at_ms: None,
        };

        assert_eq!(
            validate_session(&session, &secret, &other_device, 99),
            Err(SessionError::DeviceMismatch)
        );
    }

    #[test]
    fn csrf_token_is_bound_to_the_session_secret() {
        let secret = [7_u8; 32];
        let token = session_csrf_token(&secret).unwrap();
        validate_session_csrf(&secret, &token).unwrap();
        assert_eq!(
            validate_session_csrf(&[8_u8; 32], &token),
            Err(SessionError::InvalidCsrf)
        );
    }
}
