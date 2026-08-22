//! Request authority guards. These are the only paths from raw headers to an
//! authenticated `marks-auth` result; handlers never parse credentials.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::ids::now_ms;
use crate::store;
use axum::http::HeaderMap;
use base64ct::{Base64UrlUnpadded, Encoding};
use marks_auth::{
    AuthenticatedSession, SESSION_COOKIE_NAME, ScratchAuthority, ScratchRecord, SessionRecord,
    parse_scratch_authorization, parse_session_cookie, session_secret_hash, validate_session,
    validate_session_csrf,
};

/// Old rotated secrets stay valid this long for in-flight requests.
const ROTATION_OVERLAP_MS: u64 = 60_000;

pub struct CookieSession {
    pub session: AuthenticatedSession,
    pub secret: [u8; 32],
}

/// Validate the rotating `__Host-marks_session` cookie against the stored
/// session, device, and principal rows.
pub fn cookie_session(app: &App, headers: &HeaderMap) -> ApiResult<CookieSession> {
    let raw = session_cookie_value(headers).ok_or_else(ApiError::unauthenticated)?;
    let (session_id, secret) =
        parse_session_cookie(&raw).map_err(|_| ApiError::unauthenticated())?;
    let now = now_ms();
    app.db.read(|conn| {
        let stored =
            store::load_session(conn, &session_id)?.ok_or_else(ApiError::unauthenticated)?;
        let device = store::load_device(conn, &stored.record.device_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        let principal = store::load_principal(conn, &stored.record.principal_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        marks_auth::require_active_principal(&principal)
            .map_err(|_| ApiError::unauthenticated())?;

        let record = match validate_session(&stored.record, &secret, &device, now) {
            Ok(session) => session,
            Err(marks_auth::SessionError::InvalidSecret) => {
                // Rotation overlap: the previous secret stays valid briefly so
                // an in-flight request from the same session does not fail.
                let (Some(previous_hash), Some(rotated_at)) =
                    (stored.prev_secret_hash, stored.rotated_at_ms)
                else {
                    return Err(ApiError::unauthenticated());
                };
                if now >= rotated_at.saturating_add(ROTATION_OVERLAP_MS)
                    || previous_hash != session_secret_hash(&secret)
                {
                    return Err(ApiError::unauthenticated());
                }
                let overlapped = SessionRecord {
                    secret_hash: previous_hash,
                    ..stored.record.clone()
                };
                validate_session(&overlapped, &secret, &device, now)
                    .map_err(|_| ApiError::unauthenticated())?
            }
            Err(_) => return Err(ApiError::unauthenticated()),
        };
        Ok(CookieSession {
            session: record,
            secret,
        })
    })
}

pub struct ScratchCaller {
    pub authority: ScratchAuthority,
    pub record: ScratchRecord,
}

/// Validate the `Authorization: MarksScratch <id>.<capability>` header for a
/// live, unclaimed scratch workspace.
pub fn scratch_caller(app: &App, headers: &HeaderMap) -> ApiResult<ScratchCaller> {
    let (scratch_id, capability) = scratch_credentials(headers)?;
    app.db.read(|conn| {
        let record =
            store::load_scratch(conn, &scratch_id)?.ok_or_else(ApiError::unauthenticated)?;
        let authority = marks_auth::validate_scratch_capability(&record, &capability, now_ms())
            .map_err(|_| ApiError::unauthenticated())?;
        Ok(ScratchCaller { authority, record })
    })
}

/// The raw scratch credential without liveness rules; the claimed-scratch
/// finalize path validates it with `validate_claimed_scratch_capability`.
pub fn scratch_credentials(headers: &HeaderMap) -> ApiResult<(marks_auth::ScratchId, [u8; 32])> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(ApiError::unauthenticated)?;
    parse_scratch_authorization(header).map_err(|_| ApiError::unauthenticated())
}

fn session_cookie_value(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for pair in cookies.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair.strip_prefix(SESSION_COOKIE_NAME)
            && let Some(value) = value.strip_prefix('=')
        {
            return Some(format!("{SESSION_COOKIE_NAME}={value}"));
        }
    }
    None
}

/// Cookie-authenticated state changes require the exact configured origin.
/// Custom-header (scratch) authority is CORS-preflight-protected already.
pub fn require_same_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(ApiError::forbidden)?;
    if origin != app.config.origin {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

/// Origin may be absent (non-browser callers, same-origin GET WebSockets on
/// some agents) but must match exactly when present.
pub fn reject_foreign_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        && origin != app.config.origin
    {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

/// Session-bound CSRF for the auth-critical mutations named by the protocol.
pub fn require_csrf(headers: &HeaderMap, session_secret: &[u8; 32]) -> ApiResult<()> {
    let presented = headers
        .get("x-marks-csrf")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(ApiError::forbidden)?;
    let decoded = Base64UrlUnpadded::decode_vec(presented).map_err(|_| ApiError::forbidden())?;
    validate_session_csrf(session_secret, &decoded).map_err(|_| ApiError::forbidden())
}
