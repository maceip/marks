//! `/v1/auth`: scratch workspaces, phone-controller pairing, silent device
//! sessions, rotating cookies, and the feature-flagged EVT rail. Handlers do
//! HTTP, randomness, rate limits, and transactions; every security decision
//! is a `marks-auth` validator.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::identity;
use crate::ids::{new_id, new_secret, now_ms};
use crate::room::Control;
use crate::store;
use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64ct::{Base64UrlUnpadded, Encoding};
use marks_auth::{
    ChallengeId, ControllerBootstrap, DeviceCapabilities, DeviceGrant, DeviceId,
    DeviceSessionProof, PairingId, PrincipalId, SESSION_COOKIE_NAME, ScratchId, SessionId,
    VerifiedEmailEvidence, authorize_controller_bootstrap, authorize_device_session,
    authorize_email_promotion, authorize_locator_attach, authorize_pairing,
    authorize_pairing_finalize, authorize_pairing_inspect, authorize_pairing_request,
    authorize_revoke_device, bearer_secret_hash, bind_pending_device, encode_bearer_secret,
    pairing_matches_pending, pairing_secret_hash, scratch_capability_hash,
    select_principal_for_controller_grant, select_principal_for_email_locator, session_csrf_token,
    session_secret_hash, validate_claimed_scratch_capability,
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;

const PENDING_DEVICE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const EVT_MAX_EVIDENCE_AGE_MS: u64 = 5 * 60 * 1000;

/* ------------------------------ helpers --------------------------------- */

fn b64(value: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(value)
}

fn b64_32(text: &str) -> ApiResult<[u8; 32]> {
    let bytes =
        Base64UrlUnpadded::decode_vec(text).map_err(|_| ApiError::bad_request("bad bytes"))?;
    bytes
        .try_into()
        .map_err(|_| ApiError::bad_request("bad bytes"))
}

fn b64_any(text: &str) -> ApiResult<Vec<u8>> {
    Base64UrlUnpadded::decode_vec(text).map_err(|_| ApiError::bad_request("bad bytes"))
}

fn rate(
    app: &App,
    headers: &HeaderMap,
    addr: &SocketAddr,
    bucket: &str,
    limit: u32,
) -> ApiResult<()> {
    // Behind a trusted reverse proxy the client address is in Forwarded /
    // X-Forwarded-For; the direct peer address is the fallback.
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|| addr.ip().to_string());
    if !app
        .rate
        .allow(&format!("{bucket}:{ip}"), limit, 60_000, now_ms())
    {
        return Err(ApiError::rate_limited());
    }
    Ok(())
}

pub struct NewSession {
    pub id: SessionId,
    pub secret: [u8; 32],
}

impl NewSession {
    pub fn cookie(&self) -> HeaderValue {
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE_NAME}={}.{}; Path=/; Secure; HttpOnly; SameSite=Lax",
            self.id.as_str(),
            encode_bearer_secret(&self.secret),
        ))
        .expect("cookie value")
    }

    pub fn csrf(&self) -> ApiResult<String> {
        Ok(b64(
            &session_csrf_token(&self.secret).map_err(|_| ApiError::internal())?
        ))
    }
}

fn cleared_cookie() -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
    ))
    .expect("cookie value")
}

/// Insert one rotating session row inside the caller's transaction.
fn insert_session(
    conn: &Connection,
    app: &App,
    principal_id: &PrincipalId,
    device_id: &DeviceId,
    now: u64,
) -> ApiResult<NewSession> {
    let id = SessionId::new(new_id("session")).map_err(|_| ApiError::internal())?;
    let secret = new_secret();
    conn.execute(
        "INSERT INTO sessions (id, principal_id, device_id, secret_hash, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id.as_str(),
            principal_id.as_str(),
            device_id.as_str(),
            session_secret_hash(&secret),
            store::ms(now),
            store::ms(now.saturating_add(app.config.session_ttl_ms)),
        ],
    )?;
    Ok(NewSession { id, secret })
}

fn session_json(
    session: &NewSession,
    principal_id: &PrincipalId,
    device_id: &DeviceId,
) -> ApiResult<serde_json::Value> {
    Ok(json!({
        "principalId": principal_id.as_str(),
        "deviceId": device_id.as_str(),
        "sessionId": session.id.as_str(),
        "csrf": session.csrf()?,
    }))
}

/* ------------------------------ scratch --------------------------------- */

/// `POST /v1/auth/scratch`: unauthenticated, rate-limited creation of a
/// temporary workspace capability. Only the domain-separated digest persists.
pub async fn scratch_create(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    rate(&app, &headers, &addr, "scratch", 10)?;
    let id = new_id("scratch");
    let capability = new_secret();
    let now = now_ms();
    let expires_at = now.saturating_add(app.config.scratch_ttl_ms);
    app.db.tx(|conn| {
        conn.execute(
            "INSERT INTO scratch_workspaces (id, capability_hash, expires_at)
             VALUES (?1, ?2, ?3)",
            params![
                id,
                scratch_capability_hash(&capability),
                store::ms(expires_at)
            ],
        )?;
        Ok(())
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "scratchId": id,
            "capability": b64(&capability),
            "expiresAtMs": expires_at,
        })),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindDeviceBody {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    /// Canonical SEC1 P-256 public key, base64url.
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

/// `PUT /v1/auth/scratch/{id}/device`: bind the browser's pending key.
/// Generating the key never promotes the workspace.
pub async fn scratch_bind_device(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<BindDeviceBody>,
) -> ApiResult<Response> {
    let scratch = guard::scratch_caller(&app, &headers)?;
    if scratch.authority.scratch_id.as_str() != id {
        return Err(ApiError::unauthenticated());
    }
    let device_id =
        DeviceId::new(body.device_id).map_err(|_| ApiError::bad_request("invalid device id"))?;
    let public_key = b64_any(&body.public_key)?;
    let now = now_ms();
    let pending = bind_pending_device(
        &scratch.authority,
        device_id,
        &public_key,
        now,
        PENDING_DEVICE_TTL_MS,
    )
    .map_err(|_| ApiError::bad_request("invalid device key"))?;
    app.db.tx(|conn| {
        conn.execute(
            "INSERT INTO pending_devices
                (id, scratch_id, public_key_sec1, public_key_hash, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scratch_id) DO UPDATE SET
                id = excluded.id,
                public_key_sec1 = excluded.public_key_sec1,
                public_key_hash = excluded.public_key_hash,
                created_at = excluded.created_at,
                expires_at = excluded.expires_at",
            params![
                pending.id.as_str(),
                pending.scratch_id.as_str(),
                pending.public_key_sec1,
                pending.public_key_hash,
                store::ms(now),
                store::ms(pending.expires_at_ms),
            ],
        )?;
        Ok(())
    })?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/* ------------------------------ pairings -------------------------------- */

/// `POST /v1/auth/pairings`: a two-minute, one-use QR pairing whose 256-bit
/// secret travels only in the link fragment.
pub async fn pairing_create(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    rate(&app, &headers, &addr, "pairing", 20)?;
    let scratch = guard::scratch_caller(&app, &headers)?;
    let now = now_ms();
    let id = new_id("pairing");
    let secret = new_secret();
    let expires_at = now.saturating_add(app.config.pairing_ttl_ms);
    app.db.tx(|conn| {
        let pending = store::load_pending_device(conn, &scratch.authority.scratch_id)?
            .ok_or_else(|| ApiError::bad_request("no pending device"))?;
        authorize_pairing_request(&scratch.authority, &pending, now)
            .map_err(|_| ApiError::bad_request("no live pending device"))?;
        conn.execute(
            "INSERT INTO pairings
                (id, scratch_id, pending_device_id, pending_device_public_key_hash, secret_hash,
                 expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                scratch.authority.scratch_id.as_str(),
                pending.id.as_str(),
                pending.public_key_hash,
                pairing_secret_hash(&secret),
                store::ms(expires_at),
            ],
        )?;
        Ok(())
    })?;
    let fragment = format!("#v1.{id}.{}", b64(&secret));
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "pairingId": id,
            "secret": b64(&secret),
            "expiresAtMs": expires_at,
            "url": format!("{}/link{fragment}", app.config.origin),
        })),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingSecretBody {
    pub secret: String,
}

/// `POST /v1/auth/pairings/{id}/inspect`: safe confirmation details for the
/// phone. Requires the pairing secret; reveals nothing to a guessed ID.
pub async fn pairing_inspect(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Json(body): Json<PairingSecretBody>,
) -> ApiResult<Response> {
    let pairing_id = PairingId::new(id).map_err(|_| ApiError::unauthenticated())?;
    let secret = b64_32(&body.secret).map_err(|_| ApiError::unauthenticated())?;
    let now = now_ms();
    let details = app.db.read(|conn| {
        let pairing =
            store::load_pairing(conn, &pairing_id)?.ok_or_else(ApiError::unauthenticated)?;
        authorize_pairing_inspect(&pairing, &secret, now)
            .map_err(|_| ApiError::unauthenticated())?;
        Ok(json!({
            "origin": app.config.origin,
            "pendingDeviceId": pairing.pending_device_id.as_str(),
            "pendingDevicePublicKeyHash": b64(&pairing.pending_device_public_key_hash),
            "expiresAtMs": pairing.expires_at_ms,
        }))
    })?;
    Ok(Json(details).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BootstrapBody {
    pub secret: String,
    pub bootstrap: BootstrapStatement,
    /// Canonical SEC1 controller public key, base64url.
    #[serde(rename = "controllerPublicKey")]
    pub controller_public_key: String,
    /// 64-byte IEEE P1363 signature, base64url.
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BootstrapStatement {
    pub version: u8,
    #[serde(rename = "controllerId")]
    pub controller_id: String,
    #[serde(rename = "controllerDeviceId")]
    pub controller_device_id: String,
    #[serde(rename = "controllerPublicKeyHash")]
    pub controller_public_key_hash: String,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "scratchId")]
    pub scratch_id: String,
    #[serde(rename = "pendingDeviceId")]
    pub pending_device_id: String,
    #[serde(rename = "pendingDevicePublicKeyHash")]
    pub pending_device_public_key_hash: String,
    #[serde(rename = "issuedAtMs")]
    pub issued_at_ms: u64,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: u64,
}

impl BootstrapStatement {
    fn decode(self) -> ApiResult<ControllerBootstrap> {
        Ok(ControllerBootstrap {
            version: self.version,
            controller_id: marks_auth::ControllerId::new(self.controller_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            controller_device_id: DeviceId::new(self.controller_device_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            controller_public_key_hash: b64_32(&self.controller_public_key_hash)?,
            pairing_id: PairingId::new(self.pairing_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            scratch_id: ScratchId::new(self.scratch_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            pending_device_id: DeviceId::new(self.pending_device_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            pending_device_public_key_hash: b64_32(&self.pending_device_public_key_hash)?,
            issued_at_ms: self.issued_at_ms,
            expires_at_ms: self.expires_at_ms,
        })
    }
}

fn insert_device(
    conn: &Connection,
    device_id: &DeviceId,
    principal_id: &PrincipalId,
    public_key_sec1: &[u8],
    capabilities: DeviceCapabilities,
    now: u64,
) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO devices
            (id, principal_id, public_key_sec1, key_epoch, capability_bits, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)",
        params![
            device_id.as_str(),
            principal_id.as_str(),
            public_key_sec1,
            i64::from(capabilities.bits()),
            store::ms(now),
        ],
    )?;
    Ok(())
}

/// `POST /v1/auth/pairings/{id}/bootstrap`: first phone. One serializable
/// transaction creates the random principal, promotes both keys, claims the
/// scratch documents, and consumes the pairing.
pub async fn pairing_bootstrap(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Json(body): Json<BootstrapBody>,
) -> ApiResult<Response> {
    let pairing_id = PairingId::new(id).map_err(|_| ApiError::unauthenticated())?;
    let secret = b64_32(&body.secret).map_err(|_| ApiError::unauthenticated())?;
    let controller_public_key = b64_any(&body.controller_public_key)?;
    let signature = b64_any(&body.signature)?;
    let bootstrap = body.bootstrap.decode()?;
    if bootstrap.pairing_id != pairing_id {
        return Err(ApiError::unauthenticated());
    }
    let now = now_ms();

    let (principal_id, session, controller_device_id, changed) = app.db.tx(|conn| {
        let pairing =
            store::load_pairing(conn, &pairing_id)?.ok_or_else(ApiError::unauthenticated)?;
        let pending = store::load_pending_device(conn, &pairing.scratch_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        pairing_matches_pending(&pairing, &pending).map_err(|_| ApiError::unauthenticated())?;
        marks_auth::require_live_pending_device(&pending, &pairing.scratch_id, now)
            .map_err(|_| ApiError::unauthenticated())?;
        let authorized = authorize_controller_bootstrap(
            &pairing,
            &secret,
            &bootstrap,
            &controller_public_key,
            &signature,
            now,
        )
        .map_err(|_| ApiError::unauthenticated())?;

        // The server, never the client, generates the principal.
        let principal_id =
            PrincipalId::new(new_id("principal")).map_err(|_| ApiError::internal())?;
        conn.execute(
            "INSERT INTO principals (id, created_at) VALUES (?1, ?2)",
            params![principal_id.as_str(), store::ms(now)],
        )?;
        insert_device(
            conn,
            &authorized.controller_device_id,
            &principal_id,
            &authorized.controller_public_key_sec1,
            DeviceCapabilities::CONTROLLER,
            now,
        )?;
        conn.execute(
            "INSERT INTO controllers (id, principal_id, device_id, key_epoch, created_at)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![
                authorized.controller_id.as_str(),
                principal_id.as_str(),
                authorized.controller_device_id.as_str(),
                store::ms(now),
            ],
        )?;
        insert_device(
            conn,
            &authorized.pending_device_id,
            &principal_id,
            &pending.public_key_sec1,
            DeviceCapabilities::MEMBER,
            now,
        )?;
        let changed = identity::claim_scratch_documents(
            conn,
            &authorized.scratch_id,
            &principal_id,
            &authorized.pending_device_id,
            now,
        )?;
        identity::persist_scratch_claim(conn, &authorized.scratch_id, &principal_id, now)?;
        identity::consume_pairing(conn, &pairing, principal_id.clone(), now)?;
        // The phone authenticated with its controller signature; give its
        // device the first rotating session.
        let session = insert_session(
            conn,
            &app,
            &principal_id,
            &authorized.controller_device_id,
            now,
        )?;
        Ok((
            principal_id,
            session,
            authorized.controller_device_id,
            changed,
        ))
    })?;

    for (document_id, epoch) in changed {
        app.rooms
            .control(Control::EpochChanged { document_id, epoch })
            .await;
    }
    let body = session_json(&session, &principal_id, &controller_device_id)?;
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, session.cookie())],
        Json(body),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveBody {
    pub secret: String,
    pub grant: GrantStatement,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantStatement {
    pub version: u8,
    #[serde(rename = "principalId")]
    pub principal_id: String,
    #[serde(rename = "controllerId")]
    pub controller_id: String,
    #[serde(rename = "controllerEpoch")]
    pub controller_epoch: u64,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "scratchId")]
    pub scratch_id: String,
    #[serde(rename = "pendingDeviceId")]
    pub pending_device_id: String,
    #[serde(rename = "pendingDevicePublicKeyHash")]
    pub pending_device_public_key_hash: String,
    pub capabilities: u32,
    #[serde(rename = "issuedAtMs")]
    pub issued_at_ms: u64,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: u64,
}

impl GrantStatement {
    fn decode(self) -> ApiResult<DeviceGrant> {
        Ok(DeviceGrant {
            version: self.version,
            principal_id: PrincipalId::new(self.principal_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            controller_id: marks_auth::ControllerId::new(self.controller_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            controller_epoch: self.controller_epoch,
            pairing_id: PairingId::new(self.pairing_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            scratch_id: ScratchId::new(self.scratch_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            pending_device_id: DeviceId::new(self.pending_device_id)
                .map_err(|_| ApiError::bad_request("invalid id"))?,
            pending_device_public_key_hash: b64_32(&self.pending_device_public_key_hash)?,
            capabilities: DeviceCapabilities::from_bits(self.capabilities)
                .map_err(|_| ApiError::bad_request("unknown capability bits"))?,
            issued_at_ms: self.issued_at_ms,
            expires_at_ms: self.expires_at_ms,
        })
    }
}

/// `POST /v1/auth/pairings/{id}/approve`: an existing controller enrolls the
/// pending browser device into its principal. Same transaction as bootstrap
/// minus principal/controller creation.
pub async fn pairing_approve(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ApproveBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let pairing_id = PairingId::new(id).map_err(|_| ApiError::unauthenticated())?;
    let secret = b64_32(&body.secret).map_err(|_| ApiError::unauthenticated())?;
    let signature = b64_any(&body.signature)?;
    let grant = body.grant.decode()?;
    if grant.pairing_id != pairing_id {
        return Err(ApiError::unauthenticated());
    }
    let now = now_ms();

    let changed = app.db.tx(|conn| {
        let pairing =
            store::load_pairing(conn, &pairing_id)?.ok_or_else(ApiError::unauthenticated)?;
        let pending = store::load_pending_device(conn, &pairing.scratch_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        pairing_matches_pending(&pairing, &pending).map_err(|_| ApiError::unauthenticated())?;
        marks_auth::require_live_pending_device(&pending, &pairing.scratch_id, now)
            .map_err(|_| ApiError::unauthenticated())?;
        let controller = store::load_controller_for_device(
            conn,
            cookie.session.principal_id(),
            cookie.session.device_id(),
        )?
        .ok_or_else(ApiError::forbidden)?;
        select_principal_for_controller_grant(&controller).map_err(|_| ApiError::forbidden())?;
        let authorized = authorize_pairing(&pairing, &secret, &controller, &grant, &signature, now)
            .map_err(|_| ApiError::unauthenticated())?;

        insert_device(
            conn,
            &authorized.pending_device_id,
            &authorized.principal_id,
            &pending.public_key_sec1,
            authorized.capabilities,
            now,
        )?;
        let changed = identity::claim_scratch_documents(
            conn,
            &authorized.scratch_id,
            &authorized.principal_id,
            &authorized.pending_device_id,
            now,
        )?;
        identity::persist_scratch_claim(
            conn,
            &authorized.scratch_id,
            &authorized.principal_id,
            now,
        )?;
        identity::consume_pairing(conn, &pairing, authorized.principal_id, now)?;
        Ok(changed)
    })?;

    for (document_id, epoch) in changed {
        app.rooms
            .control(Control::EpochChanged { document_id, epoch })
            .await;
    }
    Ok(Json(json!({ "approved": true })).into_response())
}

/// `POST /v1/auth/pairings/{id}/finalize`: the desktop tab that still holds
/// the claimed scratch capability receives its first rotating session.
pub async fn pairing_finalize(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let pairing_id = PairingId::new(id).map_err(|_| ApiError::unauthenticated())?;
    let (scratch_id, capability) = guard::scratch_credentials(&headers)?;
    let now = now_ms();

    let (principal_id, device_id, session) = app.db.tx(|conn| {
        let scratch =
            store::load_scratch(conn, &scratch_id)?.ok_or_else(ApiError::unauthenticated)?;
        let claimed = validate_claimed_scratch_capability(&scratch, &capability, now)
            .map_err(|_| ApiError::unauthenticated())?;
        let pairing =
            store::load_pairing(conn, &pairing_id)?.ok_or_else(ApiError::unauthenticated)?;
        let pending =
            store::load_pending_device(conn, &scratch_id)?.ok_or_else(ApiError::unauthenticated)?;
        let finalized = authorize_pairing_finalize(&pairing, &pending, &claimed)
            .map_err(|_| ApiError::unauthenticated())?;
        // The pending browser device must now be an enrolled, live device on
        // exactly that principal.
        let device = store::load_device(conn, &finalized.pending_device_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        if device.principal_id != finalized.principal_id || device.revoked_at_ms.is_some() {
            return Err(ApiError::unauthenticated());
        }
        let session = insert_session(conn, &app, &finalized.principal_id, &device.id, now)?;
        Ok((finalized.principal_id, device.id, session))
    })?;

    let body = session_json(&session, &principal_id, &device_id)?;
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, session.cookie())],
        Json(body),
    )
        .into_response())
}

/* --------------------------- device sessions ----------------------------- */

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceChallengeBody {
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

/// `POST /v1/auth/device/challenges`: one-use, origin-bound silent-login
/// challenge. Unknown devices receive an indistinguishable response.
pub async fn device_challenge(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<DeviceChallengeBody>,
) -> ApiResult<Response> {
    rate(&app, &headers, &addr, "device-challenge", 30)?;
    let challenge_id = new_id("challenge");
    let challenge = new_secret();
    let now = now_ms();
    let expires_at = now.saturating_add(app.config.challenge_ttl_ms);
    let device_id = DeviceId::new(body.device_id).ok();
    if let Some(device_id) = &device_id {
        app.db.tx(|conn| {
            let Some(device) = store::load_device(conn, device_id)? else {
                return Ok(());
            };
            if device.revoked_at_ms.is_some() {
                return Ok(());
            }
            conn.execute(
                "INSERT INTO auth_challenges
                    (id, kind, device_id, nonce_hash, audience, expires_at, key_epoch)
                 VALUES (?1, 'device', ?2, ?3, ?4, ?5, ?6)",
                params![
                    challenge_id,
                    device_id.as_str(),
                    bearer_secret_hash(&challenge),
                    app.config.origin,
                    store::ms(expires_at),
                    store::ms(device.key_epoch),
                ],
            )?;
            Ok(())
        })?;
    }
    Ok(Json(json!({
        "challengeId": challenge_id,
        "challenge": b64(&challenge),
        "audience": app.config.origin,
        "expiresAtMs": expires_at,
    }))
    .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceRedeemBody {
    pub proof: ProofStatement,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofStatement {
    pub version: u8,
    #[serde(rename = "challengeId")]
    pub challenge_id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceKeyEpoch")]
    pub device_key_epoch: u64,
    pub audience: String,
    pub challenge: String,
    #[serde(rename = "issuedAtMs")]
    pub issued_at_ms: u64,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: u64,
}

/// `POST /v1/auth/device/redeem`: verify the canonical signed proof, consume
/// the challenge, and mint the rotating session in one transaction.
pub async fn device_redeem(
    State(app): State<Arc<App>>,
    Json(body): Json<DeviceRedeemBody>,
) -> ApiResult<Response> {
    let signature = b64_any(&body.signature)?;
    let proof = DeviceSessionProof {
        version: body.proof.version,
        challenge_id: ChallengeId::new(body.proof.challenge_id)
            .map_err(|_| ApiError::unauthenticated())?,
        device_id: DeviceId::new(body.proof.device_id).map_err(|_| ApiError::unauthenticated())?,
        device_key_epoch: body.proof.device_key_epoch,
        audience: body.proof.audience,
        challenge: b64_32(&body.proof.challenge).map_err(|_| ApiError::unauthenticated())?,
        issued_at_ms: body.proof.issued_at_ms,
        expires_at_ms: body.proof.expires_at_ms,
    };
    let now = now_ms();

    let (principal_id, device_id, session) = app.db.tx(|conn| {
        let record = store::load_device_challenge(conn, &proof.challenge_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        let device =
            store::load_device(conn, &record.device_id)?.ok_or_else(ApiError::unauthenticated)?;
        let principal = store::load_principal(conn, &device.principal_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        marks_auth::require_active_principal(&principal)
            .map_err(|_| ApiError::unauthenticated())?;
        let authenticated = authorize_device_session(&record, &device, &proof, &signature, now)
            .map_err(|_| ApiError::unauthenticated())?;
        let consumed = conn.execute(
            "UPDATE auth_challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
            params![record.id.as_str(), store::ms(now)],
        )?;
        if consumed != 1 {
            return Err(ApiError::unauthenticated());
        }
        conn.execute(
            "UPDATE devices SET last_used_at = ?2 WHERE id = ?1",
            params![device.id.as_str(), store::ms(now)],
        )?;
        let session = insert_session(
            conn,
            &app,
            &authenticated.principal_id,
            &authenticated.device_id,
            now,
        )?;
        Ok((authenticated.principal_id, authenticated.device_id, session))
    })?;

    let body = session_json(&session, &principal_id, &device_id)?;
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, session.cookie())],
        Json(body),
    )
        .into_response())
}

/* ------------------------------ sessions -------------------------------- */

/// `GET /v1/auth/session`: session bootstrap. Returns the CSRF token and
/// rotates the secret past the sliding interval.
pub async fn session_get(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let now = now_ms();
    let rotate = app.db.read(|conn| {
        let stored = store::load_session(conn, cookie.session.id())?
            .ok_or_else(ApiError::unauthenticated)?;
        let last = stored.rotated_at_ms.unwrap_or_else(|| {
            stored
                .record
                .expires_at_ms
                .saturating_sub(app.config.session_ttl_ms)
        });
        Ok(now.saturating_sub(last) >= app.config.session_rotate_after_ms)
    })?;

    if rotate {
        let secret = new_secret();
        app.db.tx(|conn| {
            conn.execute(
                "UPDATE sessions
                 SET prev_secret_hash = secret_hash, secret_hash = ?2, rotated_at = ?3,
                     expires_at = ?4
                 WHERE id = ?1 AND revoked_at IS NULL",
                params![
                    cookie.session.id().as_str(),
                    session_secret_hash(&secret),
                    store::ms(now),
                    store::ms(now.saturating_add(app.config.session_ttl_ms)),
                ],
            )?;
            Ok(())
        })?;
        let session = NewSession {
            id: cookie.session.id().clone(),
            secret,
        };
        let body = session_json(
            &session,
            cookie.session.principal_id(),
            cookie.session.device_id(),
        )?;
        return Ok(([(header::SET_COOKIE, session.cookie())], Json(body)).into_response());
    }

    Ok(Json(json!({
        "principalId": cookie.session.principal_id().as_str(),
        "deviceId": cookie.session.device_id().as_str(),
        "sessionId": cookie.session.id().as_str(),
        "csrf": b64(&session_csrf_token(&cookie.secret).map_err(|_| ApiError::internal())?),
    }))
    .into_response())
}

/// `DELETE /v1/auth/session`: logout. Revokes the row and closes its sockets.
pub async fn session_delete(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    guard::require_csrf(&headers, &cookie.secret)?;
    app.db.tx(|conn| {
        conn.execute(
            "UPDATE sessions SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![cookie.session.id().as_str(), store::ms(now_ms())],
        )?;
        Ok(())
    })?;
    app.rooms
        .control(Control::SessionRevoked {
            session_id: cookie.session.id().as_str().to_owned(),
        })
        .await;
    Ok((
        [(header::SET_COOKIE, cleared_cookie())],
        Json(json!({ "revoked": true })),
    )
        .into_response())
}

/// `GET /v1/auth/devices`: enumerate controllers, devices, and sessions.
pub async fn devices_list(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let principal = cookie.session.principal_id().as_str().to_owned();
    let body = app.db.read(|conn| {
        let mut devices = Vec::new();
        let mut statement = conn.prepare(
            "SELECT id, capability_bits, key_epoch, created_at, last_used_at, revoked_at
             FROM devices WHERE principal_id = ?1",
        )?;
        let rows = statement.query_map(params![principal], |row| {
            Ok(json!({
                "deviceId": row.get::<_, String>(0)?,
                "capabilities": row.get::<_, i64>(1)?,
                "keyEpoch": row.get::<_, i64>(2)?,
                "createdAtMs": row.get::<_, i64>(3)?,
                "lastUsedAtMs": row.get::<_, Option<i64>>(4)?,
                "revokedAtMs": row.get::<_, Option<i64>>(5)?,
            }))
        })?;
        for row in rows {
            devices.push(row?);
        }
        let mut controllers = Vec::new();
        let mut statement = conn.prepare(
            "SELECT id, device_id, created_at, revoked_at FROM controllers WHERE principal_id = ?1",
        )?;
        let rows = statement.query_map(params![principal], |row| {
            Ok(json!({
                "controllerId": row.get::<_, String>(0)?,
                "deviceId": row.get::<_, String>(1)?,
                "createdAtMs": row.get::<_, i64>(2)?,
                "revokedAtMs": row.get::<_, Option<i64>>(3)?,
            }))
        })?;
        for row in rows {
            controllers.push(row?);
        }
        let mut sessions = Vec::new();
        let mut statement = conn.prepare(
            "SELECT id, device_id, created_at, expires_at, revoked_at
             FROM sessions WHERE principal_id = ?1",
        )?;
        let rows = statement.query_map(params![principal], |row| {
            Ok(json!({
                "sessionId": row.get::<_, String>(0)?,
                "deviceId": row.get::<_, String>(1)?,
                "createdAtMs": row.get::<_, i64>(2)?,
                "expiresAtMs": row.get::<_, i64>(3)?,
                "revokedAtMs": row.get::<_, Option<i64>>(4)?,
            }))
        })?;
        for row in rows {
            sessions.push(row?);
        }
        Ok(json!({ "devices": devices, "controllers": controllers, "sessions": sessions }))
    })?;
    Ok(Json(body).into_response())
}

/// `DELETE /v1/auth/devices/{id}`: controller-only revocation of a device and
/// every descendant session; live sockets close immediately.
pub async fn device_revoke(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    guard::require_csrf(&headers, &cookie.secret)?;
    let target_id = DeviceId::new(id).map_err(|_| ApiError::not_found())?;
    let revoked_sessions = app.db.tx(|conn| {
        let actor = store::load_device(conn, cookie.session.device_id())?
            .ok_or_else(ApiError::forbidden)?;
        let target = store::load_device(conn, &target_id)?.ok_or_else(ApiError::not_found)?;
        authorize_revoke_device(&actor, &target).map_err(|_| ApiError::forbidden())?;
        let now = store::ms(now_ms());
        conn.execute(
            "UPDATE devices SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![target.id.as_str(), now],
        )?;
        conn.execute(
            "UPDATE controllers SET revoked_at = ?2 WHERE device_id = ?1 AND revoked_at IS NULL",
            params![target.id.as_str(), now],
        )?;
        let mut statement =
            conn.prepare("SELECT id FROM sessions WHERE device_id = ?1 AND revoked_at IS NULL")?;
        let sessions: Vec<String> = statement
            .query_map(params![target.id.as_str()], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        conn.execute(
            "UPDATE sessions SET revoked_at = ?2 WHERE device_id = ?1 AND revoked_at IS NULL",
            params![target.id.as_str(), now],
        )?;
        Ok(sessions)
    })?;
    app.rooms
        .control(Control::DeviceRevoked {
            device_id: target_id.as_str().to_owned(),
        })
        .await;
    for session_id in revoked_sessions {
        app.rooms
            .control(Control::SessionRevoked { session_id })
            .await;
    }
    Ok(Json(json!({ "revoked": true })).into_response())
}

/* --------------------------------- EVT ----------------------------------- */

/// `POST /v1/auth/evt/challenges`: bind one EVT attempt to the scratch,
/// pending device, exact audience, and adapter version. Feature-flagged.
pub async fn evt_challenge(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    if !app.config.evt_enabled {
        return Err(ApiError::not_found());
    }
    let scratch = guard::scratch_caller(&app, &headers)?;
    let now = now_ms();
    let id = new_id("challenge");
    let nonce = b64(&new_secret());
    let expires_at = now.saturating_add(app.config.challenge_ttl_ms);
    app.db.tx(|conn| {
        let pending = store::load_pending_device(conn, &scratch.authority.scratch_id)?
            .ok_or_else(|| ApiError::bad_request("no pending device"))?;
        marks_auth::require_live_pending_device(&pending, &scratch.authority.scratch_id, now)
            .map_err(|_| ApiError::bad_request("no live pending device"))?;
        conn.execute(
            "INSERT INTO auth_challenges
                (id, kind, scratch_id, bound_device_id, bound_public_key_hash, nonce_hash,
                 audience, adapter_version, expires_at)
             VALUES (?1, 'evt', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                scratch.authority.scratch_id.as_str(),
                pending.id.as_str(),
                pending.public_key_hash,
                bearer_secret_hash(nonce.as_bytes()),
                app.config.origin,
                app.config.evt_adapter_version,
                store::ms(expires_at),
            ],
        )?;
        Ok(())
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "challengeId": id,
            "nonce": nonce,
            "audience": app.config.origin,
            "adapterVersion": app.config.evt_adapter_version,
            "expiresAtMs": expires_at,
        })),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvtRedeemBody {
    pub nonce: String,
    pub evidence: EvidenceStatement,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceStatement {
    #[serde(rename = "challengeId")]
    pub challenge_id: String,
    pub issuer: String,
    #[serde(rename = "canonicalEmail")]
    pub canonical_email: String,
    pub audience: String,
    pub nonce: String,
    #[serde(rename = "issuedAtMs")]
    pub issued_at_ms: u64,
    #[serde(rename = "adapterVersion")]
    pub adapter_version: String,
}

/// `POST /v1/auth/evt/redeem`. The issuer-facing verification (DNS
/// delegation, SD-JWT, key binding) lives in a narrow adapter. This server
/// ships the validated transaction path; without a trusted adapter build the
/// endpoint fails closed with 501 rather than trusting caller-supplied
/// evidence.
pub async fn evt_redeem(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<EvtRedeemBody>,
) -> ApiResult<Response> {
    if !app.config.evt_enabled {
        return Err(ApiError::not_found());
    }
    // The only adapter today is the explicit test shim. Production deploys
    // keep it off, so redemption is refused before touching any record.
    if std::env::var("MARKS_EVT_INSECURE_TEST_ADAPTER")
        .ok()
        .as_deref()
        != Some("1")
    {
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "no trusted EVT adapter is configured",
        ));
    }
    let scratch = guard::scratch_caller(&app, &headers)?;
    let evidence = VerifiedEmailEvidence {
        challenge_id: ChallengeId::new(body.evidence.challenge_id)
            .map_err(|_| ApiError::unauthenticated())?,
        issuer: body.evidence.issuer,
        canonical_email: body.evidence.canonical_email,
        audience: body.evidence.audience,
        nonce: body.evidence.nonce,
        issued_at_ms: body.evidence.issued_at_ms,
        adapter_version: body.evidence.adapter_version,
    };
    let now = now_ms();

    let (principal_id, device_id, session, changed) = app.db.tx(|conn| {
        let challenge = conn
            .query_row(
                "SELECT id, scratch_id, bound_device_id, bound_public_key_hash, nonce_hash,
                        audience, adapter_version, expires_at, consumed_at
                 FROM auth_challenges WHERE id = ?1 AND kind = 'evt'",
                params![evidence.challenge_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<Vec<u8>>>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .map_err(|_| ApiError::unauthenticated())?;
        let (
            id,
            challenge_scratch,
            bound_device,
            bound_key_hash,
            nonce_hash,
            audience,
            adapter,
            expires_at,
            consumed_at,
        ) = challenge;
        let record = marks_auth::EmailChallengeRecord {
            id: ChallengeId::new(id).map_err(|_| ApiError::internal())?,
            scratch_id: ScratchId::new(challenge_scratch.ok_or_else(ApiError::unauthenticated)?)
                .map_err(|_| ApiError::internal())?,
            pending_device_id: DeviceId::new(bound_device.ok_or_else(ApiError::unauthenticated)?)
                .map_err(|_| ApiError::internal())?,
            pending_device_public_key_hash: store::hash32(
                bound_key_hash.ok_or_else(ApiError::unauthenticated)?,
            )?,
            nonce_hash: store::hash32(nonce_hash)?,
            audience,
            adapter_version: adapter.ok_or_else(ApiError::unauthenticated)?,
            expires_at_ms: store::from_ms(expires_at),
            consumed_at_ms: consumed_at.map(store::from_ms),
        };
        if record.scratch_id != scratch.authority.scratch_id {
            return Err(ApiError::unauthenticated());
        }
        let promotion = authorize_email_promotion(
            &record,
            &body.nonce,
            &evidence,
            &app.config.evt_locator_key,
            now,
            EVT_MAX_EVIDENCE_AGE_MS,
        )
        .map_err(|_| ApiError::unauthenticated())?;

        let existing = conn
            .query_row(
                "SELECT principal_id, issuer_policy_version, revoked_at
                 FROM verified_email_locators
                 WHERE locator_key_version = ?1 AND locator = ?2",
                params![
                    app.config.evt_locator_key_version,
                    promotion.locator.as_bytes().as_slice(),
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                error => Err(error),
            })?;
        let existing_record = existing
            .map(|(principal, policy, revoked_at)| {
                Ok::<_, ApiError>(marks_auth::VerifiedEmailLocatorRecord {
                    locator_key_version: app.config.evt_locator_key_version,
                    locator: promotion.locator,
                    principal_id: PrincipalId::new(principal).map_err(|_| ApiError::internal())?,
                    issuer_policy_version: u32::try_from(policy)
                        .map_err(|_| ApiError::internal())?,
                    revoked_at_ms: revoked_at.map(store::from_ms),
                })
            })
            .transpose()?;

        let principal_id = match select_principal_for_email_locator(existing_record.as_ref()) {
            marks_auth::SelectedPrincipal::Existing(principal) => principal,
            marks_auth::SelectedPrincipal::Create => {
                let principal =
                    PrincipalId::new(new_id("principal")).map_err(|_| ApiError::internal())?;
                conn.execute(
                    "INSERT INTO principals (id, created_at) VALUES (?1, ?2)",
                    params![principal.as_str(), store::ms(now)],
                )?;
                conn.execute(
                    "INSERT INTO verified_email_locators
                        (locator_key_version, locator, principal_id, issuer_policy_version,
                         created_at)
                     VALUES (?1, ?2, ?3, 1, ?4)",
                    params![
                        app.config.evt_locator_key_version,
                        promotion.locator.as_bytes().as_slice(),
                        principal.as_str(),
                        store::ms(now),
                    ],
                )?;
                principal
            }
        };
        authorize_locator_attach(existing_record.as_ref(), &principal_id)
            .map_err(|_| ApiError::conflict())?;

        let pending = store::load_pending_device(conn, &scratch.authority.scratch_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        if pending.id != promotion.pending_device_id
            || pending.public_key_hash != promotion.pending_device_public_key_hash
        {
            return Err(ApiError::unauthenticated());
        }
        insert_device(
            conn,
            &pending.id,
            &principal_id,
            &pending.public_key_sec1,
            DeviceCapabilities::MEMBER,
            now,
        )?;
        let changed = identity::claim_scratch_documents(
            conn,
            &scratch.authority.scratch_id,
            &principal_id,
            &pending.id,
            now,
        )?;
        identity::persist_scratch_claim(conn, &scratch.authority.scratch_id, &principal_id, now)?;
        let consumed = conn.execute(
            "UPDATE auth_challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
            params![record.id.as_str(), store::ms(now)],
        )?;
        if consumed != 1 {
            return Err(ApiError::unauthenticated());
        }
        let session = insert_session(conn, &app, &principal_id, &pending.id, now)?;
        let device_id = pending.id.clone();
        Ok((principal_id, device_id, session, changed))
    })?;

    for (document_id, epoch) in changed {
        app.rooms
            .control(Control::EpochChanged { document_id, epoch })
            .await;
    }
    let body = session_json(&session, &principal_id, &device_id)?;
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, session.cookie())],
        Json(body),
    )
        .into_response())
}
