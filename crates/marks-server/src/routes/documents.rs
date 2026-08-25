//! `/v1/documents` and `/v1/scratch/documents`: the product document surface.
//! Every handler resolves authority through `marks-auth` validators first;
//! unknown, deleted, and unauthorized documents are one indistinguishable 404.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::{new_id, new_secret, now_ms};
use crate::room::Control;
use crate::store;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64ct::{Base64UrlUnpadded, Encoding};
use marks_auth::{
    AuthenticatedSession, DocumentAction, DocumentId, DocumentOwner, DocumentRole, EsbtSiteId,
    LinkGrantRecord, PrincipalId, ScratchId, TicketId, authorize_document_action,
    authorize_link_grant_role, bearer_secret_hash, encode_bearer_secret, issue_document_ticket,
    issue_public_document_ticket, issue_public_scratch_document_ticket,
    issue_scratch_document_ticket, owner_acl_row, redeem_link_grant,
    require_deleted_document_owner, require_principal_document, require_scratch_document,
    resolve_document_role,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// The caller's document authority: a rotating principal session or a live
/// scratch capability. They are different kinds of authority, never merged.
pub(crate) enum Caller {
    Principal(AuthenticatedSession),
    Scratch(ScratchId),
}

pub(crate) fn caller(app: &App, headers: &HeaderMap) -> ApiResult<Caller> {
    // Protocol: session cookies are checked before any durable principal
    // operation. A leftover MarksScratch header from the UI first-paint
    // path must not hide a live rotating session.
    if let Ok(cookie) = guard::cookie_session(app, headers) {
        return Ok(Caller::Principal(cookie.session));
    }
    if headers.contains_key(header::AUTHORIZATION) {
        let scratch = guard::scratch_caller(app, headers)?;
        return Ok(Caller::Scratch(scratch.authority.scratch_id));
    }
    Err(ApiError::unauthenticated())
}

#[derive(Serialize)]
struct DocumentMeta {
    id: String,
    slug: String,
    title: String,
    engine: String,
    chars: u64,
    created_at: u64,
    updated_at: u64,
    deleted_at: Option<u64>,
    purge_at: Option<u64>,
    public: bool,
    public_role: Option<&'static str>,
    anonymous_edits: u64,
    persisted: bool,
    persisted_at: Option<u64>,
}

const TRASH_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const PURGE_ASSET_RECLAIM_TIMEOUT: Duration = Duration::from_secs(15);

fn meta(row: &store::DocumentMetaRow) -> DocumentMeta {
    DocumentMeta {
        id: row.record.id.as_str().to_owned(),
        slug: row.record.id.as_str().to_owned(),
        title: row.title.clone(),
        engine: row.engine.clone(),
        chars: row.chars,
        created_at: row.created_at_ms,
        updated_at: row.updated_at_ms,
        deleted_at: row.record.deleted_at_ms,
        purge_at: row
            .record
            .deleted_at_ms
            .map(|deleted| deleted.saturating_add(TRASH_RETENTION_MS)),
        public: row.public_edit,
        public_role: row.public_edit.then_some("editor"),
        anonymous_edits: row.anonymous_edit_count,
        persisted: row.persisted_at_ms.is_some(),
        persisted_at: row.persisted_at_ms,
    }
}

/// Resolve the caller's role on a live document, failing closed to 404.
pub(crate) fn apply_public_editor_floor(role: DocumentRole, public_edit: bool) -> DocumentRole {
    if public_edit && matches!(role, DocumentRole::Commenter | DocumentRole::Viewer) {
        DocumentRole::Editor
    } else {
        role
    }
}

pub(crate) fn resolve_caller_role(
    conn: &Connection,
    caller: &Caller,
    row: &store::DocumentMetaRow,
) -> ApiResult<Option<DocumentRole>> {
    match caller {
        Caller::Principal(session) => {
            let acl = store::load_acl(conn, &row.record.id)?;
            match resolve_document_role(&row.record, session.principal_id(), &acl) {
                Ok(role) => Ok(Some(apply_public_editor_floor(role, row.public_edit))),
                Err(_) if row.public_edit => Ok(Some(DocumentRole::Editor)),
                Err(_) => Err(ApiError::not_found()),
            }
        }
        Caller::Scratch(scratch_id) => {
            if require_scratch_document(&row.record, scratch_id).is_ok() {
                Ok(None)
            } else if row.public_edit {
                Ok(Some(DocumentRole::Editor))
            } else {
                Err(ApiError::not_found())
            }
        }
    }
}

pub(crate) fn load_live_document(
    conn: &Connection,
    document_id: &DocumentId,
) -> ApiResult<store::DocumentMetaRow> {
    let row = store::load_document(conn, document_id)?.ok_or_else(ApiError::not_found)?;
    if row.record.deleted_at_ms.is_some() {
        return Err(ApiError::not_found());
    }
    Ok(row)
}

fn load_deleted_document(
    conn: &Connection,
    document_id: &DocumentId,
) -> ApiResult<store::DocumentMetaRow> {
    let row = store::load_document(conn, document_id)?.ok_or_else(ApiError::not_found)?;
    if row.record.deleted_at_ms.is_none() {
        return Err(ApiError::not_found());
    }
    Ok(row)
}

fn require_recovery_owner(caller: &Caller, row: &store::DocumentMetaRow) -> ApiResult<()> {
    let expected = match caller {
        Caller::Principal(session) => DocumentOwner::Principal(session.principal_id().clone()),
        Caller::Scratch(scratch) => DocumentOwner::Scratch(scratch.clone()),
    };
    require_deleted_document_owner(&row.record, &expected).map_err(|_| ApiError::not_found())
}

pub async fn list(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    let documents = app.db.read(|conn| {
        let mut statement = match &caller {
            Caller::Scratch(_) => conn.prepare(
                "SELECT id FROM documents
                 WHERE scratch_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC",
            )?,
            Caller::Principal(_) => conn.prepare(
                "SELECT DISTINCT d.id FROM documents d
                 LEFT JOIN document_acl a
                    ON a.document_id = d.id AND a.revoked_at IS NULL
                 WHERE d.deleted_at IS NULL
                   AND (d.owner_principal_id = ?1 OR a.principal_id = ?1)
                 ORDER BY d.updated_at DESC",
            )?,
        };
        let key = match &caller {
            Caller::Scratch(scratch) => scratch.as_str().to_owned(),
            Caller::Principal(session) => session.principal_id().as_str().to_owned(),
        };
        let ids: Vec<String> = statement
            .query_map(params![key], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut documents = Vec::new();
        for id in ids {
            let id = DocumentId::new(id).map_err(|_| ApiError::internal())?;
            if let Some(row) = store::load_document(conn, &id)? {
                documents.push(meta(&row));
            }
        }
        Ok(documents)
    })?;
    Ok(Json(json!({ "documents": documents })).into_response())
}

/// Owner-only trash. Shared documents disappear from a collaborator's list as
/// soon as the owner deletes them; they never leak into that collaborator's
/// recovery surface.
pub async fn trash_list(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    let documents = app.db.read(|conn| {
        let (sql, key) = match &caller {
            Caller::Scratch(scratch) => (
                "SELECT id FROM documents
                 WHERE scratch_id = ?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
                scratch.as_str(),
            ),
            Caller::Principal(session) => (
                "SELECT id FROM documents
                 WHERE owner_principal_id = ?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
                session.principal_id().as_str(),
            ),
        };
        let mut statement = conn.prepare(sql)?;
        let ids = statement
            .query_map(params![key], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut documents = Vec::with_capacity(ids.len());
        for id in ids {
            let id = DocumentId::new(id).map_err(|_| ApiError::internal())?;
            let row = load_deleted_document(conn, &id)?;
            require_recovery_owner(&caller, &row)?;
            documents.push(meta(&row));
        }
        Ok(documents)
    })?;
    Ok(Json(json!({
        "documents": documents,
        "retentionMs": TRASH_RETENTION_MS,
    }))
    .into_response())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    pub title: Option<String>,
    /// Optional canonical Markdown used to initialize a document atomically.
    /// Templates must not create an empty catalog row and fill it later: that
    /// would expose a transient blank document to collaborators and make a
    /// failed second request indistinguishable from a blank template.
    pub markdown: Option<String>,
    /// Authority-scoped retry identity. Reusing it with the exact normalized
    /// payload returns the original slug; rebinding it is a conflict.
    pub request_id: Option<String>,
}

pub async fn create(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Option<Json<CreateBody>>,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let title = body.title.as_deref().map(str::trim);
    if title.is_some_and(|title| title.is_empty() || title.len() > 512) {
        return Err(ApiError::bad_request("invalid title"));
    }
    let markdown = body.markdown.unwrap_or_default();
    let chars = markdown.encode_utf16().count();
    if chars > app.limits.max_document_units {
        return Err(ApiError::bad_request("document is too large"));
    }
    validate_create_request_id(body.request_id.as_deref())?;
    let request_hash = body
        .request_id
        .as_ref()
        .map(|_| create_request_hash(title, &markdown));

    // The common ambiguous-commit path is a retry after process restart. Do
    // the durable lookup before reconstructing a potentially large CRDT seed;
    // the transaction below repeats it to close concurrent-create races.
    if let (Some(request_id), Some(request_hash)) =
        (body.request_id.as_deref(), request_hash.as_ref())
        && let Some(row) = app
            .db
            .read(|conn| load_create_replay(conn, &caller, request_id, request_hash))?
    {
        return Ok(Json(json!({ "document": meta(&row), "replayed": true })).into_response());
    }

    // Construct the initial state before opening the SQLite transaction. The
    // transaction then publishes metadata and the causally closed snapshot as
    // one unit; there is never a remotely observable blank intermediary.
    let (snapshot, initial_operations) = if markdown.is_empty() {
        (None, Vec::new())
    } else {
        let mut seed = esbt::Document::new(
            EsbtSiteId::SERVER.to_engine_site(),
            esbt::ReplicaConfig::default(),
            app.limits.clone(),
        )
        .map_err(|_| ApiError::internal())?;
        let update = seed
            .insert(0, &markdown, None)
            .map_err(|_| ApiError::bad_request("document is too large"))?
            .ok_or_else(ApiError::internal)?;
        let operations = update
            .update
            .operations()
            .iter()
            .map(|operation| (operation.origin.to_string(), operation.seq))
            .collect();
        let snapshot = seed
            .export_compact_snapshot()
            .or_else(|_| seed.export_full_snapshot())
            .map_err(|_| ApiError::internal())?;
        (Some(snapshot), operations)
    };
    let now = now_ms();
    let id = new_id("document");
    let (row, replayed) = app.db.tx(|conn| {
        if let (Some(request_id), Some(request_hash)) =
            (body.request_id.as_deref(), request_hash.as_ref())
            && let Some(row) = load_create_replay(conn, &caller, request_id, request_hash)?
        {
            return Ok((row, true));
        }
        let (scratch_id, owner_id) = match &caller {
            Caller::Scratch(scratch) => (Some(scratch.as_str()), None),
            Caller::Principal(session) => (None, Some(session.principal_id().as_str())),
        };
        conn.execute(
            "INSERT INTO documents
                (id, scratch_id, owner_principal_id, title, title_explicit, engine, chars,
                 auth_epoch, snapshot, snapshot_revision, created_at, updated_at, public_edit,
                 create_request_id, create_request_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, 'esbt', ?6, 1, ?7, 0, ?8, ?8, ?9, ?10, ?11)",
            params![
                id,
                scratch_id,
                owner_id,
                title.unwrap_or("Untitled"),
                i64::from(title.is_some()),
                store::ms(chars as u64),
                snapshot,
                store::ms(now),
                i64::from(matches!(&caller, Caller::Scratch(_))),
                body.request_id,
                request_hash.as_ref().map(<[u8; 32]>::as_slice),
            ],
        )?;
        let id = DocumentId::new(id.clone()).map_err(|_| ApiError::internal())?;
        if let Caller::Principal(session) = &caller {
            let acl = owner_acl_row(id.clone(), session.principal_id().clone());
            conn.execute(
                "INSERT INTO document_acl (document_id, principal_id, role, granted_by, created_at)
                 VALUES (?1, ?2, ?3, ?2, ?4)",
                params![
                    acl.document_id.as_str(),
                    acl.principal_id.as_str(),
                    store::role_to_str(acl.role),
                    store::ms(now),
                ],
            )?;
        }
        let (actor_kind, actor_id, session_id) = match &caller {
            Caller::Scratch(scratch) => ("scratch", scratch.as_str(), None),
            Caller::Principal(session) => (
                "principal",
                session.principal_id().as_str(),
                Some(session.id().as_str()),
            ),
        };
        for (site, sequence) in &initial_operations {
            conn.execute(
                "INSERT INTO op_authors
                    (document_id, site, seq, actor_kind, actor_id, session_id, received_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id.as_str(),
                    site,
                    store::ms(*sequence),
                    actor_kind,
                    actor_id,
                    session_id,
                    store::ms(now),
                ],
            )?;
        }
        Ok((load_live_document(conn, &id)?, false))
    })?;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(json!({ "document": meta(&row), "replayed": replayed })),
    )
        .into_response())
}

fn create_request_hash(title: Option<&str>, markdown: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"marks-document-create-v1\0");
    match title {
        Some(title) => {
            hash.update([1]);
            hash.update((title.len() as u64).to_be_bytes());
            hash.update(title.as_bytes());
        }
        None => hash.update([0]),
    }
    hash.update((markdown.len() as u64).to_be_bytes());
    hash.update(markdown.as_bytes());
    hash.finalize().into()
}

fn duplicate_request_hash(document_id: &DocumentId) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"marks-document-duplicate-v1\0");
    hash.update(document_id.as_str().as_bytes());
    hash.finalize().into()
}

fn validate_create_request_id(request_id: Option<&str>) -> ApiResult<()> {
    if request_id.is_some_and(|request_id| {
        request_id.is_empty()
            || request_id.len() > 128
            || !request_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
    }) {
        return Err(ApiError::bad_request("invalid request id"));
    }
    Ok(())
}

fn load_create_replay(
    conn: &Connection,
    caller: &Caller,
    request_id: &str,
    request_hash: &[u8; 32],
) -> ApiResult<Option<store::DocumentMetaRow>> {
    let found: Option<(String, Vec<u8>)> = match caller {
        Caller::Scratch(scratch) => conn
            .query_row(
                "SELECT id, create_request_hash FROM documents
                 WHERE scratch_id = ?1 AND create_request_id = ?2",
                params![scratch.as_str(), request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
        Caller::Principal(session) => conn
            .query_row(
                "SELECT id, create_request_hash FROM documents
                 WHERE owner_principal_id = ?1 AND create_request_id = ?2",
                params![session.principal_id().as_str(), request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
    };
    let Some((id, stored_hash)) = found else {
        return Ok(None);
    };
    if stored_hash.as_slice() != request_hash {
        return Err(ApiError::conflict());
    }
    let id = DocumentId::new(id).map_err(|_| ApiError::internal())?;
    Ok(Some(load_live_document(conn, &id)?))
}

pub async fn get(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let row = app.db.read(|conn| {
        let row = load_live_document(conn, &document_id)?;
        resolve_caller_role(conn, &caller, &row)?;
        Ok(row)
    })?;
    let connections = app.rooms.connection_count(&document_id).unwrap_or(0);
    Ok(Json(json!({ "document": meta(&row), "connections": connections })).into_response())
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub title: String,
}

pub async fn rename(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RenameBody>,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    if body.title.trim().is_empty() || body.title.len() > 512 {
        return Err(ApiError::bad_request("invalid title"));
    }
    let row = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &caller, &row)?;
        conn.execute(
            "UPDATE documents SET title = ?2, title_explicit = 1, updated_at = ?3 WHERE id = ?1",
            params![document_id.as_str(), body.title.trim(), store::ms(now_ms())],
        )?;
        load_live_document(conn, &document_id)
    })?;
    Ok(Json(json!({ "document": meta(&row) })).into_response())
}

/// Rename, delete, share management: owner authority only. Scratch authority
/// owns exactly its own private documents.
fn require_owner(
    conn: &Connection,
    caller: &Caller,
    row: &store::DocumentMetaRow,
) -> ApiResult<()> {
    match caller {
        Caller::Principal(session) => {
            let role = resolve_caller_role(conn, caller, row)?.ok_or_else(ApiError::not_found)?;
            if role != DocumentRole::Owner {
                return Err(ApiError::forbidden());
            }
            require_principal_document(&row.record, session.principal_id())
                .map_err(|_| ApiError::not_found())
        }
        Caller::Scratch(scratch_id) => {
            require_scratch_document(&row.record, scratch_id).map_err(|_| ApiError::not_found())
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateBody {
    pub request_id: Option<String>,
}

pub async fn duplicate(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<DuplicateBody>>,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let body = body.map(|Json(body)| body).unwrap_or_default();
    validate_create_request_id(body.request_id.as_deref())?;
    let request_hash = body
        .request_id
        .as_ref()
        .map(|_| duplicate_request_hash(&document_id));
    if let (Some(request_id), Some(request_hash)) =
        (body.request_id.as_deref(), request_hash.as_ref())
        && let Some(row) = app
            .db
            .read(|conn| load_create_replay(conn, &caller, request_id, request_hash))?
    {
        return Ok(Json(json!({ "document": meta(&row), "replayed": true })).into_response());
    }
    let text = document_text(&app, &caller, &document_id).await?;

    let mut seed = esbt::Document::new(
        EsbtSiteId::SERVER.to_engine_site(),
        esbt::ReplicaConfig::default(),
        app.limits.clone(),
    )
    .map_err(|_| ApiError::internal())?;
    if !text.is_empty() {
        seed.insert(0, &text, None)
            .map_err(|_| ApiError::internal())?;
    }
    let snapshot = seed
        .export_full_snapshot()
        .map_err(|_| ApiError::internal())?;

    let now = now_ms();
    let new_document = new_id("document");
    let (row, replayed) = app.db.tx(|conn| {
        if let (Some(request_id), Some(request_hash)) =
            (body.request_id.as_deref(), request_hash.as_ref())
            && let Some(row) = load_create_replay(conn, &caller, request_id, request_hash)?
        {
            return Ok((row, true));
        }
        let source = load_live_document(conn, &document_id)?;
        resolve_caller_role(conn, &caller, &source)?;
        let (scratch_id, owner_id) = match &caller {
            Caller::Scratch(scratch) => (Some(scratch.as_str()), None),
            Caller::Principal(session) => (None, Some(session.principal_id().as_str())),
        };
        conn.execute(
            "INSERT INTO documents
                (id, scratch_id, owner_principal_id, title, title_explicit, engine, chars,
                 auth_epoch, snapshot, snapshot_revision, created_at, updated_at, public_edit,
                 create_request_id, create_request_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, 'esbt', ?6, 1, ?7, 0, ?8, ?8, ?9, ?10, ?11)",
            params![
                new_document,
                scratch_id,
                owner_id,
                format!("{} (copy)", source.title),
                i64::from(source.title_explicit),
                store::ms(text.encode_utf16().count() as u64),
                snapshot,
                store::ms(now),
                i64::from(matches!(&caller, Caller::Scratch(_))),
                body.request_id,
                request_hash.as_ref().map(<[u8; 32]>::as_slice),
            ],
        )?;
        let id = DocumentId::new(new_document.clone()).map_err(|_| ApiError::internal())?;
        if let Caller::Principal(session) = &caller {
            let acl = owner_acl_row(id.clone(), session.principal_id().clone());
            conn.execute(
                "INSERT INTO document_acl (document_id, principal_id, role, granted_by, created_at)
                 VALUES (?1, ?2, ?3, ?2, ?4)",
                params![
                    acl.document_id.as_str(),
                    acl.principal_id.as_str(),
                    store::role_to_str(acl.role),
                    store::ms(now),
                ],
            )?;
        }
        Ok((load_live_document(conn, &id)?, false))
    })?;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(json!({ "document": meta(&row), "replayed": replayed })),
    )
        .into_response())
}

pub async fn delete(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &caller, &row)?;
        let now = store::ms(now_ms());
        // A durable tombstone plus an epoch bump: outstanding tickets fail
        // closed and reconnecting replicas can never recreate the row.
        conn.execute(
            "UPDATE documents SET deleted_at = ?2, auth_epoch = auth_epoch + 1 WHERE id = ?1",
            params![document_id.as_str(), now],
        )?;
        conn.execute(
            "UPDATE document_tickets SET revoked_at = ?2
             WHERE document_id = ?1 AND consumed_at IS NULL AND revoked_at IS NULL",
            params![document_id.as_str(), now],
        )?;
        Ok(())
    })?;
    app.rooms.control(Control::Deleted {
        document_id: document_id.as_str().to_owned(),
    });
    Ok(Json(json!({ "deleted": true })).into_response())
}

pub async fn restore(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let row = app.db.tx(|conn| {
        let row = load_deleted_document(conn, &document_id)?;
        require_recovery_owner(&caller, &row)?;
        conn.execute(
            "UPDATE documents
             SET deleted_at = NULL, updated_at = ?2, auth_epoch = auth_epoch + 1
             WHERE id = ?1 AND deleted_at IS NOT NULL",
            params![document_id.as_str(), store::ms(now_ms())],
        )?;
        load_live_document(conn, &document_id)
    })?;
    Ok(Json(json!({ "document": meta(&row) })).into_response())
}

/// Physically reclaim a tombstone only after its advertised retention window.
/// The transaction removes dependents in FK order, so an interrupted purge is
/// either wholly visible or not visible at all.
pub async fn purge(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let reclaim_deadline = Instant::now() + PURGE_ASSET_RECLAIM_TIMEOUT;
    let _asset_mutation_guard = app.assets.mutation_guard_before(reclaim_deadline).await?;
    let reclaim_assets = app.db.tx(|conn| {
        let row = load_deleted_document(conn, &document_id)?;
        require_recovery_owner(&caller, &row)?;
        let purge_at = row
            .record
            .deleted_at_ms
            .unwrap_or_default()
            .saturating_add(TRASH_RETENTION_MS);
        if now_ms() < purge_at {
            return Err(ApiError::conflict());
        }
        let id = document_id.as_str();
        let asset_hashes = {
            let mut statement =
                conn.prepare("SELECT content_hash FROM document_assets WHERE document_id = ?1")?;
            statement
                .query_map(params![id], |row| row.get::<_, Vec<u8>>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        conn.execute(
            "DELETE FROM document_comment_replies
             WHERE comment_id IN (SELECT id FROM document_comments WHERE document_id = ?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM document_assets WHERE document_id = ?1",
            params![id],
        )?;
        for table in [
            "document_comments",
            "document_versions",
            "document_version_blobs",
            "document_commits",
            "document_updates",
            "document_tickets",
            "document_sites",
            "link_grants",
            "document_acl",
            "op_authors",
            "op_author_ranges",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE document_id = ?1"),
                params![id],
            )?;
        }
        let mut reclaim = Vec::new();
        for hash in asset_hashes {
            let removed = conn.execute(
                "DELETE FROM asset_blobs WHERE content_hash = ?1
                   AND NOT EXISTS(SELECT 1 FROM document_assets WHERE content_hash = ?1)",
                params![hash],
            )?;
            if removed == 1 {
                reclaim.push(store::hash32(hash)?);
            }
        }
        conn.execute("DELETE FROM documents WHERE id = ?1", params![id])?;
        Ok(reclaim)
    })?;
    let reclaim_count = reclaim_assets.len();
    let reclaimed_all = complete_batch_before_deadline(reclaim_assets, reclaim_deadline, |hash| {
        let app = app.clone();
        async move { reclaim_purged_asset(&app, hash).await }
    })
    .await;
    if !reclaimed_all {
        // The authorization graph is already gone. Leftover unreferenced
        // content hashes are safe and startup reconciliation will sweep them;
        // an unhealthy filesystem must not retain the global mutation guard
        // once the aggregate cleanup budget expires.
        tracing::warn!(
            target: "marks_server::assets",
            reclaim_count,
            timeout_ms = PURGE_ASSET_RECLAIM_TIMEOUT.as_millis(),
            "asset reclaim batch timed out"
        );
    }
    Ok(Json(json!({ "purged": true })).into_response())
}

async fn reclaim_purged_asset(app: &App, hash: [u8; 32]) {
    let _content_guard = app.assets.content_guard(hash).await;
    let referenced = app.db.read(|conn| {
        let referenced = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM document_assets WHERE content_hash = ?1
             )",
            params![hash.as_slice()],
            |row| row.get::<_, bool>(0),
        )?;
        Ok(referenced)
    });
    if matches!(referenced.as_ref(), Ok(true)) {
        return;
    }
    if let Err(error) = &referenced {
        tracing::warn!(target: "marks_server::assets", ?error, "could not recheck reclaimed asset reference");
        return;
    }
    if let Err(error) = app.assets.remove(hash).await {
        tracing::warn!(target: "marks_server::assets", ?error, "could not reclaim orphaned asset bytes");
    }
}

async fn complete_batch_before_deadline<T, F, Work>(
    items: impl IntoIterator<Item = T>,
    deadline: Instant,
    mut work: F,
) -> bool
where
    F: FnMut(T) -> Work,
    Work: Future<Output = ()>,
{
    for item in items {
        if tokio::time::timeout_at(deadline, work(item)).await.is_err() {
            return false;
        }
    }
    true
}

/// The exact current text: from the live room when resident (the room
/// journals before acknowledging, so this includes the freshest committed
/// edits), otherwise from durable snapshot + journal replay.
pub(crate) async fn document_text(
    app: &App,
    caller: &Caller,
    document_id: &DocumentId,
) -> ApiResult<String> {
    app.db.read(|conn| {
        let row = load_live_document(conn, document_id)?;
        let role = resolve_caller_role(conn, caller, &row)?;
        if let Some(role) = role
            && !authorize_document_action(role, DocumentAction::Export)
        {
            return Err(ApiError::forbidden());
        }
        Ok(())
    })?;
    if let Some(read) = app.rooms.read(document_id).await {
        return Ok(read.text);
    }
    app.db.read(|conn| {
        let (document, _) = store::hydrate_document(conn, document_id, &app.limits)?;
        Ok(document.text())
    })
}

pub async fn export(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let text = document_text(&app, &caller, &document_id).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/markdown; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"document.md\"",
            ),
        ],
        text,
    )
        .into_response())
}

pub async fn snapshot(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.read(|conn| {
        let row = load_live_document(conn, &document_id)?;
        resolve_caller_role(conn, &caller, &row)?;
        Ok(())
    })?;
    let shallow = query.get("shallow").is_some_and(|value| value == "1");

    let bytes = if let Some(read) = app.rooms.read(&document_id).await {
        if shallow {
            // Compact snapshots carry no retained oplog; they are the shallow
            // cold-open payload. A room with causal gaps falls back to full.
            read.compact_snapshot.or(read.full_snapshot)
        } else {
            read.full_snapshot
        }
    } else {
        app.db.read(|conn| {
            let (document, _) = store::hydrate_document(conn, &document_id, &app.limits)?;
            Ok(if shallow {
                document
                    .export_compact_snapshot()
                    .or_else(|_| document.export_full_snapshot())
                    .ok()
            } else {
                document.export_full_snapshot().ok()
            })
        })?
    };
    let bytes = bytes.ok_or_else(ApiError::internal)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

#[derive(Deserialize, Default)]
pub struct SessionBody {
    /// Site the replica was previously assigned on this document, if any.
    /// Sites are room-allocated; unknown or foreign values allocate fresh.
    #[serde(rename = "siteId")]
    pub site_id: Option<serde_json::Value>,
}

fn requested_site(body: &SessionBody) -> Option<u32> {
    match body.site_id.as_ref()? {
        serde_json::Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        serde_json::Value::String(text) => text.parse::<u32>().ok(),
        _ => None,
    }
}

fn ticket_response(
    document_id: &DocumentId,
    ticket_id: &TicketId,
    secret: &[u8; 32],
    role: Option<DocumentRole>,
    site: EsbtSiteId,
    identity: &marks_auth::RoomIdentity,
) -> Response {
    Json(json!({
        "roomUrl": format!("/collab/esbt/{}", document_id.as_str()),
        "ticketId": ticket_id.as_str(),
        "ticketSecret": encode_bearer_secret(secret),
        "role": role.map(store::role_to_str),
        "siteId": site.as_u32().to_string(),
        "displayIdentity": {
            "participantId": identity.participant_id,
            "displayName": identity.display_name,
            "avatar": identity.avatar,
        },
    }))
    .into_response()
}

/// `POST /v1/documents/{id}/session`: mint the 30-second one-use room ticket
/// for a durable principal, bound to principal/session/device/document/site/
/// role/epoch.
pub async fn principal_room_session(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<SessionBody>>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let requested = body.as_deref().and_then(requested_site);
    let now = now_ms();
    let secret = new_secret();
    let ticket_id = TicketId::new(new_id("ticket")).map_err(|_| ApiError::internal())?;

    let (site, role) = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        let role = resolve_caller_role(conn, &Caller::Principal(cookie.session.clone()), &row)?
            .ok_or_else(ApiError::not_found)?;
        let site = store::allocate_site(
            conn,
            &document_id,
            requested,
            "principal",
            None,
            Some(cookie.session.principal_id()),
            Some(cookie.session.device_id()),
            now,
        )?;
        let ticket = if matches!(row.record.owner, DocumentOwner::Scratch(_)) {
            issue_public_document_ticket(
                ticket_id.clone(),
                &secret,
                &cookie.session,
                &row.record,
                row.public_edit,
                site,
                now,
            )
        } else {
            issue_document_ticket(
                ticket_id.clone(),
                &secret,
                &cookie.session,
                &row.record,
                role,
                site,
                now,
            )
        }
        .map_err(|_| ApiError::unauthenticated())?;
        insert_principal_ticket(conn, &ticket)?;
        Ok((site, role))
    })?;
    Ok(ticket_response(
        &document_id,
        &ticket_id,
        &secret,
        Some(role),
        site,
        &crate::room::ws::principal_identity(cookie.session.principal_id().as_str()),
    ))
}

/// `POST /v1/scratch/documents/{id}/session`: the scratch-authority analogue.
pub async fn scratch_room_session(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<SessionBody>>,
) -> ApiResult<Response> {
    let scratch = guard::scratch_caller(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let requested = body.as_deref().and_then(requested_site);
    let now = now_ms();
    let secret = new_secret();
    let ticket_id = TicketId::new(new_id("ticket")).map_err(|_| ApiError::internal())?;

    let (site, role) = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        let record = store::load_scratch(conn, &scratch.authority.scratch_id)?
            .ok_or_else(ApiError::unauthenticated)?;
        let role = resolve_caller_role(
            conn,
            &Caller::Scratch(scratch.authority.scratch_id.clone()),
            &row,
        )?;
        let site = store::allocate_site(
            conn,
            &document_id,
            requested,
            "scratch",
            Some(&scratch.authority.scratch_id),
            None,
            None,
            now,
        )?;
        let ticket = if role == Some(DocumentRole::Editor) {
            issue_public_scratch_document_ticket(
                ticket_id.clone(),
                &secret,
                &record,
                &row.record,
                row.public_edit,
                site,
                now,
            )
        } else {
            issue_scratch_document_ticket(
                ticket_id.clone(),
                &secret,
                &record,
                &row.record,
                site,
                now,
            )
        }
        .map_err(|_| ApiError::not_found())?;
        insert_scratch_ticket(conn, &ticket)?;
        Ok((site, role))
    })?;
    Ok(ticket_response(
        &document_id,
        &ticket_id,
        &secret,
        role,
        site,
        &crate::room::ws::scratch_identity(
            document_id.as_str(),
            scratch.authority.scratch_id.as_str(),
        ),
    ))
}

fn insert_principal_ticket(
    conn: &Connection,
    ticket: &marks_auth::DocumentTicketRecord,
) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO document_tickets
            (id, secret_hash, authority_kind, principal_id, session_id, device_id, document_id,
             site_id, role, auth_epoch, expires_at)
         VALUES (?1, ?2, 'principal', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            ticket.id.as_str(),
            ticket.secret_hash,
            ticket.principal_id.as_str(),
            ticket.session_id.as_str(),
            ticket.device_id.as_str(),
            ticket.document_id.as_str(),
            i64::from(ticket.esbt_site.as_u32()),
            store::role_to_str(ticket.role),
            store::ms(ticket.authorization_epoch),
            store::ms(ticket.expires_at_ms),
        ],
    )?;
    Ok(())
}

fn insert_scratch_ticket(
    conn: &Connection,
    ticket: &marks_auth::ScratchDocumentTicketRecord,
) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO document_tickets
            (id, secret_hash, authority_kind, scratch_id, document_id, site_id, auth_epoch,
             expires_at)
         VALUES (?1, ?2, 'scratch', ?3, ?4, ?5, ?6, ?7)",
        params![
            ticket.id.as_str(),
            ticket.secret_hash,
            ticket.scratch_id.as_str(),
            ticket.document_id.as_str(),
            i64::from(ticket.esbt_site.as_u32()),
            store::ms(ticket.authorization_epoch),
            store::ms(ticket.expires_at_ms),
        ],
    )?;
    Ok(())
}

/* ------------------------------- sharing -------------------------------- */

#[derive(Deserialize)]
pub struct ShareBody {
    pub role: String,
}

/// `PUT /v1/documents/{id}/shares/{principalId}`: grant or change a role.
/// Every change bumps the authorization epoch; the live room re-resolves or
/// closes affected sockets instead of waiting for ticket expiry.
pub async fn share_put(
    State(app): State<Arc<App>>,
    Path((id, principal)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ShareBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let grantee = PrincipalId::new(principal).map_err(|_| ApiError::bad_request("invalid id"))?;
    let role =
        store::role_from_str(&body.role).map_err(|_| ApiError::bad_request("invalid role"))?;
    if role == DocumentRole::Owner {
        return Err(ApiError::bad_request("shares cannot grant owner"));
    }
    let epoch = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &Caller::Principal(cookie.session.clone()), &row)?;
        if store::load_principal(conn, &grantee)?.is_none() {
            return Err(ApiError::not_found());
        }
        if let DocumentOwner::Principal(owner) = &row.record.owner
            && owner == &grantee
        {
            return Err(ApiError::conflict());
        }
        let now = store::ms(now_ms());
        conn.execute(
            "INSERT INTO document_acl (document_id, principal_id, role, granted_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(document_id, principal_id)
             DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by,
                           revoked_at = NULL",
            params![
                document_id.as_str(),
                grantee.as_str(),
                store::role_to_str(role),
                cookie.session.principal_id().as_str(),
                now,
            ],
        )?;
        bump_epoch(conn, &document_id)
    })?;
    app.rooms.control(Control::EpochChanged {
        document_id: document_id.as_str().to_owned(),
        epoch,
    });
    Ok(Json(json!({ "role": store::role_to_str(role) })).into_response())
}

pub async fn share_delete(
    State(app): State<Arc<App>>,
    Path((id, principal)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let grantee = PrincipalId::new(principal).map_err(|_| ApiError::bad_request("invalid id"))?;
    let epoch = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &Caller::Principal(cookie.session.clone()), &row)?;
        conn.execute(
            "UPDATE document_acl SET revoked_at = ?3
             WHERE document_id = ?1 AND principal_id = ?2 AND revoked_at IS NULL",
            params![document_id.as_str(), grantee.as_str(), store::ms(now_ms())],
        )?;
        bump_epoch(conn, &document_id)
    })?;
    app.rooms.control(Control::EpochChanged {
        document_id: document_id.as_str().to_owned(),
        epoch,
    });
    Ok(Json(json!({ "revoked": true })).into_response())
}

pub async fn shares_list(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let shares = app.db.read(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &Caller::Principal(cookie.session.clone()), &row)?;
        let acl = store::load_acl(conn, &document_id)?;
        Ok(acl
            .iter()
            .filter(|grant| grant.revoked_at_ms.is_none())
            .map(|grant| {
                json!({
                    "principalId": grant.principal_id.as_str(),
                    "role": store::role_to_str(grant.role),
                })
            })
            .collect::<Vec<_>>())
    })?;
    Ok(Json(json!({ "shares": shares })).into_response())
}

#[derive(Deserialize)]
pub struct LinkBody {
    pub role: String,
    #[serde(rename = "ttlMs")]
    pub ttl_ms: Option<u64>,
}

/// `POST /v1/documents/{id}/link`: a rotatable share capability distinct from
/// the document ID. Never grants owner. Creating a new link revokes previous
/// ones (rotation).
pub async fn link_create(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<LinkBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let role =
        store::role_from_str(&body.role).map_err(|_| ApiError::bad_request("invalid role"))?;
    authorize_link_grant_role(role).map_err(|_| ApiError::bad_request("invalid role"))?;
    let token = new_secret();
    let ttl = body
        .ttl_ms
        .unwrap_or(7 * 24 * 60 * 60 * 1000)
        .min(90 * 24 * 60 * 60 * 1000);
    let now = now_ms();
    let epoch = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &Caller::Principal(cookie.session.clone()), &row)?;
        conn.execute(
            "UPDATE link_grants SET revoked_at = ?2
             WHERE document_id = ?1 AND revoked_at IS NULL",
            params![document_id.as_str(), store::ms(now)],
        )?;
        conn.execute(
            "INSERT INTO link_grants (document_id, token_hash, role, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                document_id.as_str(),
                bearer_secret_hash(&token),
                store::role_to_str(role),
                store::ms(now),
                store::ms(now.saturating_add(ttl)),
            ],
        )?;
        bump_epoch(conn, &document_id)
    })?;
    app.rooms.control(Control::EpochChanged {
        document_id: document_id.as_str().to_owned(),
        epoch,
    });
    Ok(Json(json!({
        "token": Base64UrlUnpadded::encode_string(&token),
        "role": store::role_to_str(role),
        "expiresAtMs": now.saturating_add(ttl),
    }))
    .into_response())
}

pub async fn link_revoke(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let epoch = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        require_owner(conn, &Caller::Principal(cookie.session.clone()), &row)?;
        conn.execute(
            "UPDATE link_grants SET revoked_at = ?2
             WHERE document_id = ?1 AND revoked_at IS NULL",
            params![document_id.as_str(), store::ms(now_ms())],
        )?;
        bump_epoch(conn, &document_id)
    })?;
    app.rooms.control(Control::EpochChanged {
        document_id: document_id.as_str().to_owned(),
        epoch,
    });
    Ok(Json(json!({ "revoked": true })).into_response())
}

#[derive(Deserialize)]
pub struct LinkRedeemBody {
    pub token: String,
}

/// `POST /v1/documents/{id}/link/redeem`: an authenticated principal turns a
/// live link capability into a durable ACL row for itself.
pub async fn link_redeem(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<LinkRedeemBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let token =
        Base64UrlUnpadded::decode_vec(&body.token).map_err(|_| ApiError::unauthenticated())?;
    let now = now_ms();
    let role = app.db.tx(|conn| {
        let row = load_live_document(conn, &document_id)?;
        let grants = load_link_grants(conn, &document_id)?;
        let role = grants
            .iter()
            .find_map(|grant| redeem_link_grant(grant, &token, &document_id, now).ok())
            .ok_or_else(ApiError::unauthenticated)?;
        // The document owner already outranks any link role.
        if let DocumentOwner::Principal(owner) = &row.record.owner
            && owner == cookie.session.principal_id()
        {
            return Ok(DocumentRole::Owner);
        }
        let existing = store::load_acl(conn, &document_id)?
            .into_iter()
            .find(|grant| {
                grant.principal_id == *cookie.session.principal_id()
                    && grant.revoked_at_ms.is_none()
            });
        if let Some(existing) = existing {
            return Ok(existing.role);
        }
        conn.execute(
            "INSERT INTO document_acl (document_id, principal_id, role, granted_by, created_at)
             VALUES (?1, ?2, ?3, ?2, ?4)
             ON CONFLICT(document_id, principal_id)
             DO UPDATE SET role = excluded.role, revoked_at = NULL",
            params![
                document_id.as_str(),
                cookie.session.principal_id().as_str(),
                store::role_to_str(role),
                store::ms(now),
            ],
        )?;
        Ok(role)
    })?;
    Ok(Json(json!({ "role": store::role_to_str(role) })).into_response())
}

fn load_link_grants(
    conn: &Connection,
    document_id: &DocumentId,
) -> ApiResult<Vec<LinkGrantRecord>> {
    let mut statement = conn.prepare(
        "SELECT token_hash, role, expires_at, revoked_at
         FROM link_grants WHERE document_id = ?1",
    )?;
    let rows = statement.query_map(params![document_id.as_str()], |row| {
        Ok((
            row.get::<_, Vec<u8>>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<i64>>(3)?,
        ))
    })?;
    let mut grants = Vec::new();
    for row in rows {
        let (token_hash, role, expires_at, revoked_at) = row?;
        grants.push(LinkGrantRecord {
            document_id: document_id.clone(),
            token_hash: store::hash32(token_hash)?,
            role: store::role_from_str(&role)?,
            expires_at_ms: store::from_ms(expires_at),
            revoked_at_ms: revoked_at.map(store::from_ms),
        });
    }
    Ok(grants)
}

/// Increment and return the document's authorization epoch inside the
/// caller's transaction.
fn bump_epoch(conn: &Connection, document_id: &DocumentId) -> ApiResult<u64> {
    conn.execute(
        "UPDATE documents SET auth_epoch = auth_epoch + 1 WHERE id = ?1",
        params![document_id.as_str()],
    )?;
    let epoch: i64 = conn.query_row(
        "SELECT auth_epoch FROM documents WHERE id = ?1",
        params![document_id.as_str()],
        |row| row.get(0),
    )?;
    // Outstanding one-use tickets minted under the previous epoch fail closed.
    conn.execute(
        "UPDATE document_tickets SET revoked_at = ?2
         WHERE document_id = ?1 AND consumed_at IS NULL AND revoked_at IS NULL",
        params![document_id.as_str(), store::ms(now_ms())],
    )?;
    Ok(store::from_ms(epoch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[test]
    fn public_editor_access_cannot_be_narrowed_by_a_named_acl() {
        assert_eq!(
            apply_public_editor_floor(DocumentRole::Viewer, true),
            DocumentRole::Editor
        );
        assert_eq!(
            apply_public_editor_floor(DocumentRole::Commenter, true),
            DocumentRole::Editor
        );
        assert_eq!(
            apply_public_editor_floor(DocumentRole::Owner, true),
            DocumentRole::Owner
        );
        assert_eq!(
            apply_public_editor_floor(DocumentRole::Viewer, false),
            DocumentRole::Viewer
        );
    }

    #[tokio::test]
    async fn purge_reclamation_uses_one_absolute_batch_deadline() {
        struct DropProof(Arc<AtomicBool>);
        impl Drop for DropProof {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let attempts = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let completed = tokio::time::timeout(
            Duration::from_secs(1),
            complete_batch_before_deadline(
                0..1_000,
                Instant::now() + Duration::from_millis(25),
                |_| {
                    let attempts = attempts.clone();
                    let dropped = dropped.clone();
                    async move {
                        attempts.fetch_add(1, Ordering::AcqRel);
                        let _drop_proof = DropProof(dropped);
                        std::future::pending::<()>().await;
                    }
                },
            ),
        )
        .await
        .expect("aggregate reclaim deadline returned");

        assert!(!completed);
        assert_eq!(attempts.load(Ordering::Acquire), 1);
        assert!(
            dropped.load(Ordering::Acquire),
            "the in-flight reclaim future was not cancelled"
        );
    }
}
