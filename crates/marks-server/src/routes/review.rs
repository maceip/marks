//! Durable comment threads and named Markdown versions.
//!
//! This is intentionally a product-metadata plane. Comments do not become
//! ESBT operations, and versions capture canonical Markdown rather than an
//! engine-specific snapshot. That keeps review ACLs explicit and makes a
//! saved version portable even if the live CRDT format evolves.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::{new_id, now_ms};
use crate::routes::documents::{Caller, document_text, load_live_document, resolve_caller_role};
use crate::store;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64ct::{Base64UrlUnpadded, Encoding};
use marks_auth::{DocumentAction, DocumentId, DocumentRole, authorize_document_action};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

const MAX_COMMENT_BYTES: usize = 16 * 1024;
const MAX_COMMENT_QUOTE_BYTES: usize = 16 * 1024;
const MAX_ANCHOR_BYTES: usize = 32 * 1024;
const MAX_COMMENTS_PER_DOCUMENT: u64 = 10_000;
const MAX_REPLIES_PER_COMMENT: u64 = 200;
const COMMENT_PAGE_SIZE: i64 = 25;
const COMMENT_REPLY_PAGE_SIZE: i64 = 5_000;
const MAX_VERSION_LABEL_BYTES: usize = 160;
const MAX_VERSIONS_PER_DOCUMENT: u64 = 100;
const MAX_VERSION_BLOB_BYTES_PER_DOCUMENT: u64 = 64 * 1024 * 1024;
const VERSION_COMPRESSION_LEVEL: i32 = 3;

fn principal_role(
    conn: &Connection,
    session: &marks_auth::AuthenticatedSession,
    document_id: &DocumentId,
) -> ApiResult<DocumentRole> {
    let row = load_live_document(conn, document_id)?;
    resolve_caller_role(conn, &Caller::Principal(session.clone()), &row)?
        .ok_or_else(ApiError::not_found)
}

fn require_action(role: DocumentRole, action: DocumentAction) -> ApiResult<()> {
    if authorize_document_action(role, action) {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

fn validate_message(body: &str) -> ApiResult<&str> {
    let text = body.trim();
    if text.is_empty() || text.len() > MAX_COMMENT_BYTES {
        return Err(ApiError::bad_request("invalid comment"));
    }
    Ok(text)
}

fn encoded_anchor(anchor: Option<Vec<u8>>) -> Option<String> {
    anchor.map(|bytes| Base64UrlUnpadded::encode_string(&bytes))
}

fn decode_anchor(value: &str, limits: &esbt::ResourceLimits) -> ApiResult<Vec<u8>> {
    let bytes = Base64UrlUnpadded::decode_vec(value)
        .map_err(|_| ApiError::bad_request("invalid review anchor"))?;
    if bytes.is_empty() || bytes.len() > MAX_ANCHOR_BYTES {
        return Err(ApiError::bad_request("invalid review anchor"));
    }
    esbt::Anchor::decode_with_limits(&bytes, limits)
        .map_err(|_| ApiError::bad_request("invalid review anchor"))?;
    Ok(bytes)
}

struct ValidatedRange {
    start: Option<Vec<u8>>,
    end: Option<Vec<u8>>,
    quote: String,
    start_offset: u64,
    end_offset: u64,
}

#[derive(Default, Deserialize)]
pub struct CommentListQuery {
    cursor: Option<String>,
}

struct CommentCursor {
    created_at: i64,
    id: String,
}

fn encode_comment_cursor(created_at: i64, id: &str) -> String {
    Base64UrlUnpadded::encode_string(format!("{created_at}:{id}").as_bytes())
}

fn decode_comment_cursor(value: Option<&str>) -> ApiResult<Option<CommentCursor>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let decoded = Base64UrlUnpadded::decode_vec(value)
        .map_err(|_| ApiError::bad_request("invalid comment cursor"))?;
    if decoded.len() > 160 {
        return Err(ApiError::bad_request("invalid comment cursor"));
    }
    let decoded = std::str::from_utf8(&decoded)
        .map_err(|_| ApiError::bad_request("invalid comment cursor"))?;
    let (created_at, id) = decoded
        .split_once(':')
        .ok_or_else(|| ApiError::bad_request("invalid comment cursor"))?;
    let created_at = created_at
        .parse::<i64>()
        .ok()
        .filter(|value| *value >= 0)
        .ok_or_else(|| ApiError::bad_request("invalid comment cursor"))?;
    if !(8..=128).contains(&id.len())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ApiError::bad_request("invalid comment cursor"));
    }
    Ok(Some(CommentCursor {
        created_at,
        id: id.to_owned(),
    }))
}

fn validate_range(body: &CommentCreateBody, app: &App) -> ApiResult<ValidatedRange> {
    let quote = body.quote.clone().unwrap_or_default();
    if quote.len() > MAX_COMMENT_QUOTE_BYTES {
        return Err(ApiError::bad_request("comment quote is too large"));
    }
    match (&body.start_anchor, &body.end_anchor) {
        (None, None) => Ok(ValidatedRange {
            start: None,
            end: None,
            quote,
            start_offset: 0,
            end_offset: 0,
        }),
        (Some(start), Some(end)) => {
            let start_offset = body
                .start_offset
                .ok_or_else(|| ApiError::bad_request("review offsets are required"))?;
            let end_offset = body
                .end_offset
                .ok_or_else(|| ApiError::bad_request("review offsets are required"))?;
            if start_offset > end_offset
                || usize::try_from(end_offset)
                    .map_or(true, |offset| offset > app.limits.max_document_units)
            {
                return Err(ApiError::bad_request("invalid review offsets"));
            }
            Ok(ValidatedRange {
                start: Some(decode_anchor(start, &app.limits)?),
                end: Some(decode_anchor(end, &app.limits)?),
                quote,
                start_offset,
                end_offset,
            })
        }
        _ => Err(ApiError::bad_request("review anchors must be paired")),
    }
}

pub async fn comments_list(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Query(query): Query<CommentListQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let cursor = decode_comment_cursor(query.cursor.as_deref())?;
    let before_created_at = cursor.as_ref().map(|cursor| cursor.created_at);
    let before_id = cursor.as_ref().map(|cursor| cursor.id.as_str());
    let (comments, has_more, next_cursor, replies_truncated) = app.db.read(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Read)?;
        let mut statement = conn.prepare(
            "SELECT id, author_principal_id, body, created_at, resolved,
                    start_anchor, end_anchor, quote, start_offset, end_offset,
                    edited_at, deleted_at
             FROM document_comments
             WHERE document_id = ?1
               AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
             ORDER BY created_at DESC, id DESC LIMIT ?4",
        )?;
        let mut rows = statement
            .query_map(
                params![
                    document_id.as_str(),
                    before_created_at,
                    before_id,
                    COMMENT_PAGE_SIZE + 1
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<Vec<u8>>>(5)?,
                        row.get::<_, Option<Vec<u8>>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                        row.get::<_, Option<i64>>(11)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = rows.len() > COMMENT_PAGE_SIZE as usize;
        rows.truncate(COMMENT_PAGE_SIZE as usize);
        let next_cursor = if has_more {
            rows.last().map(|row| encode_comment_cursor(row.3, &row.0))
        } else {
            None
        };
        let mut indexes = HashMap::new();
        let mut comments = Vec::with_capacity(rows.len());
        for (
            id,
            author,
            body,
            created_at,
            resolved,
            start,
            end,
            quote,
            start_offset,
            end_offset,
            edited_at,
            deleted_at,
        ) in rows
        {
            indexes.insert(id.clone(), comments.len());
            comments.push(json!({
                "id": id,
                "documentId": document_id.as_str(),
                "author": author,
                "own": author == cookie.session.principal_id().as_str(),
                "body": if deleted_at.is_some() { "" } else { body.as_str() },
                "createdAt": store::from_ms(created_at),
                "editedAt": edited_at.map(store::from_ms),
                "deleted": deleted_at.is_some(),
                "resolved": resolved != 0,
                "startAnchor": encoded_anchor(start),
                "endAnchor": encoded_anchor(end),
                "quote": quote,
                "startOffset": store::from_ms(start_offset),
                "endOffset": store::from_ms(end_offset),
                "replies": [],
            }));
        }

        // One joined query for the page avoids an N+1 reply lookup while
        // preserving deterministic thread order.
        let mut replies = conn.prepare(
            "SELECT r.id, r.comment_id, r.author_principal_id, r.body,
                    r.created_at, r.edited_at, r.deleted_at
             FROM document_comment_replies r
             JOIN (
                 SELECT id FROM document_comments
                 WHERE document_id = ?1
                   AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
                 ORDER BY created_at DESC, id DESC LIMIT ?4
             ) page ON page.id = r.comment_id
             ORDER BY r.created_at ASC, r.id ASC LIMIT ?5",
        )?;
        let mut reply_rows = replies
            .query_map(
                params![
                    document_id.as_str(),
                    before_created_at,
                    before_id,
                    COMMENT_PAGE_SIZE,
                    COMMENT_REPLY_PAGE_SIZE + 1
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let replies_truncated = reply_rows.len() > COMMENT_REPLY_PAGE_SIZE as usize;
        reply_rows.truncate(COMMENT_REPLY_PAGE_SIZE as usize);
        for (id, comment_id, author, body, created_at, edited_at, deleted_at) in reply_rows {
            let Some(index) = indexes.get(&comment_id).copied() else {
                continue;
            };
            let Some(items) = comments[index]["replies"].as_array_mut() else {
                continue;
            };
            items.push(json!({
                "id": id,
                "author": author,
                "own": author == cookie.session.principal_id().as_str(),
                "body": if deleted_at.is_some() { "" } else { body.as_str() },
                "createdAt": store::from_ms(created_at),
                "editedAt": edited_at.map(store::from_ms),
                "deleted": deleted_at.is_some(),
            }));
        }
        Ok((comments, has_more, next_cursor, replies_truncated))
    })?;
    Ok(Json(json!({
        "comments": comments,
        "hasMore": has_more,
        "nextCursor": next_cursor,
        "repliesTruncated": replies_truncated,
    }))
    .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentCreateBody {
    body: String,
    start_anchor: Option<String>,
    end_anchor: Option<String>,
    quote: Option<String>,
    start_offset: Option<u64>,
    end_offset: Option<u64>,
}

pub async fn comment_create(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CommentCreateBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let text = validate_message(&body.body)?;
    let range = validate_range(&body, &app)?;
    let comment_id = new_id("comment");
    let created_at = now_ms();
    let author = cookie.session.principal_id().as_str().to_owned();
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Comment)?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM document_comments WHERE document_id = ?1",
            params![document_id.as_str()],
            |row| row.get(0),
        )?;
        if store::from_ms(count) >= MAX_COMMENTS_PER_DOCUMENT {
            return Err(ApiError::conflict());
        }
        conn.execute(
            "INSERT INTO document_comments
                (id, document_id, author_principal_id, body, created_at,
                 start_anchor, end_anchor, quote, start_offset, end_offset)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                comment_id,
                document_id.as_str(),
                author,
                text,
                store::ms(created_at),
                range.start,
                range.end,
                range.quote,
                store::ms(range.start_offset),
                store::ms(range.end_offset),
            ],
        )?;
        Ok(())
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "comment": {
                "id": comment_id,
                "documentId": document_id.as_str(),
                "author": author,
                "own": true,
                "body": text,
                "createdAt": created_at,
                "editedAt": null,
                "deleted": false,
                "resolved": false,
                "startAnchor": body.start_anchor,
                "endAnchor": body.end_anchor,
                "quote": body.quote.unwrap_or_default(),
                "startOffset": body.start_offset.unwrap_or_default(),
                "endOffset": body.end_offset.unwrap_or_default(),
                "replies": [],
            }
        })),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct CommentUpdateBody {
    resolved: Option<bool>,
    body: Option<String>,
}

pub async fn comment_update(
    State(app): State<Arc<App>>,
    Path((id, comment)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CommentUpdateBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Comment)?;
        if body.resolved.is_none() && body.body.is_none() {
            return Err(ApiError::bad_request("no comment change"));
        }
        let author: String = conn
            .query_row(
                "SELECT author_principal_id FROM document_comments
                 WHERE id = ?1 AND document_id = ?2",
                params![comment, document_id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(ApiError::not_found)?;
        if let Some(resolved) = body.resolved {
            conn.execute(
                "UPDATE document_comments
                 SET resolved = ?3, resolved_at = ?4, resolved_by_principal_id = ?5
                 WHERE id = ?1 AND document_id = ?2",
                params![
                    comment,
                    document_id.as_str(),
                    i64::from(resolved),
                    resolved.then(|| store::ms(now_ms())),
                    resolved.then(|| cookie.session.principal_id().as_str()),
                ],
            )?;
        }
        if let Some(next) = body.body.as_deref() {
            if author != cookie.session.principal_id().as_str() {
                return Err(ApiError::forbidden());
            }
            let text = validate_message(next)?;
            conn.execute(
                "UPDATE document_comments SET body = ?3, edited_at = ?4, deleted_at = NULL
                 WHERE id = ?1 AND document_id = ?2",
                params![comment, document_id.as_str(), text, store::ms(now_ms())],
            )?;
        }
        if author.is_empty() {
            return Err(ApiError::not_found());
        }
        Ok(())
    })?;
    Ok(Json(json!({ "updated": true })).into_response())
}

pub async fn comment_delete(
    State(app): State<Arc<App>>,
    Path((id, comment)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Comment)?;
        let changed = conn.execute(
            "UPDATE document_comments SET body = '', deleted_at = ?4
             WHERE id = ?1 AND document_id = ?2 AND author_principal_id = ?3
               AND deleted_at IS NULL",
            params![
                comment,
                document_id.as_str(),
                cookie.session.principal_id().as_str(),
                store::ms(now_ms()),
            ],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found());
        }
        Ok(())
    })?;
    Ok(Json(json!({ "deleted": true })).into_response())
}

#[derive(Deserialize)]
pub struct ReplyBody {
    body: String,
}

pub async fn reply_create(
    State(app): State<Arc<App>>,
    Path((id, comment)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ReplyBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let text = validate_message(&body.body)?;
    let reply_id = new_id("reply");
    let author = cookie.session.principal_id().as_str().to_owned();
    let created_at = now_ms();
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Comment)?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM document_comment_replies r
             JOIN document_comments c ON c.id = r.comment_id
             WHERE r.comment_id = ?1 AND c.document_id = ?2",
            params![comment, document_id.as_str()],
            |row| row.get(0),
        )?;
        if count == 0 {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM document_comments WHERE id = ?1 AND document_id = ?2)",
                params![comment, document_id.as_str()],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(ApiError::not_found());
            }
        }
        if store::from_ms(count) >= MAX_REPLIES_PER_COMMENT {
            return Err(ApiError::conflict());
        }
        conn.execute(
            "INSERT INTO document_comment_replies
                (id, comment_id, author_principal_id, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![reply_id, comment, author, text, store::ms(created_at)],
        )?;
        Ok(())
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "reply": {
                "id": reply_id,
                "author": author,
                "own": true,
                "body": text,
                "createdAt": created_at,
                "editedAt": null,
                "deleted": false,
            }
        })),
    )
        .into_response())
}

pub async fn reply_update(
    State(app): State<Arc<App>>,
    Path((id, comment, reply)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<ReplyBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let text = validate_message(&body.body)?;
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Comment)?;
        let changed = conn.execute(
            "UPDATE document_comment_replies SET body = ?5, edited_at = ?6, deleted_at = NULL
             WHERE id = ?1 AND comment_id = ?2 AND author_principal_id = ?3
               AND EXISTS(SELECT 1 FROM document_comments c
                          WHERE c.id = ?2 AND c.document_id = ?4)",
            params![
                reply,
                comment,
                cookie.session.principal_id().as_str(),
                document_id.as_str(),
                text,
                store::ms(now_ms())
            ],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found());
        }
        Ok(())
    })?;
    Ok(Json(json!({ "updated": true })).into_response())
}

pub async fn reply_delete(
    State(app): State<Arc<App>>,
    Path((id, comment, reply)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Comment)?;
        let changed = conn.execute(
            "UPDATE document_comment_replies SET body = '', deleted_at = ?5
             WHERE id = ?1 AND comment_id = ?2 AND author_principal_id = ?3
               AND EXISTS(SELECT 1 FROM document_comments c
                          WHERE c.id = ?2 AND c.document_id = ?4)",
            params![
                reply,
                comment,
                cookie.session.principal_id().as_str(),
                document_id.as_str(),
                store::ms(now_ms())
            ],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found());
        }
        Ok(())
    })?;
    Ok(Json(json!({ "deleted": true })).into_response())
}

pub async fn versions_list(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let versions = app.db.read(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Read)?;
        let mut statement = conn.prepare(
            "SELECT v.id, v.label, v.author_principal_id, v.created_at, b.chars
             FROM document_versions v
             JOIN document_version_blobs b
               ON b.document_id = v.document_id AND b.content_hash = v.content_hash
             WHERE v.document_id = ?1 ORDER BY v.created_at DESC LIMIT ?2",
        )?;
        let rows = statement
            .query_map(
                params![document_id.as_str(), MAX_VERSIONS_PER_DOCUMENT as i64],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "documentId": document_id.as_str(),
                        "label": row.get::<_, String>(1)?,
                        "author": row.get::<_, String>(2)?,
                        "createdAt": store::from_ms(row.get::<_, i64>(3)?),
                        "chars": store::from_ms(row.get::<_, i64>(4)?),
                    }))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(
        Json(json!({ "versions": versions, "retention": MAX_VERSIONS_PER_DOCUMENT }))
            .into_response(),
    )
}

#[derive(Deserialize)]
pub struct VersionCreateBody {
    label: String,
}

pub async fn version_create(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<VersionCreateBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let label = body.label.trim();
    if label.is_empty() || label.len() > MAX_VERSION_LABEL_BYTES {
        return Err(ApiError::bad_request("invalid version label"));
    }

    // Read from the resident room when present; its mutation ACK contract
    // means this is committed server state, not an arbitrary browser payload.
    let markdown = document_text(
        &app,
        &Caller::Principal(cookie.session.clone()),
        &document_id,
    )
    .await?;
    let markdown_bytes = markdown.as_bytes();
    let content_hash: [u8; 32] = Sha256::digest(markdown_bytes).into();
    let compressed = zstd::bulk::compress(markdown_bytes, VERSION_COMPRESSION_LEVEL)
        .map_err(|_| ApiError::internal())?;
    let chars = markdown.encode_utf16().count() as u64;
    let created_at = now_ms();
    let version_id = new_id("version");
    let author = cookie.session.principal_id().as_str().to_owned();

    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::EditText)?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM document_versions WHERE document_id = ?1",
            params![document_id.as_str()],
            |row| row.get(0),
        )?;
        if store::from_ms(count) >= MAX_VERSIONS_PER_DOCUMENT {
            return Err(ApiError::conflict());
        }
        let already_stored: bool = conn
            .query_row(
                "SELECT 1 FROM document_version_blobs
                 WHERE document_id = ?1 AND content_hash = ?2",
                params![document_id.as_str(), content_hash.as_slice()],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !already_stored {
            let stored: i64 = conn.query_row(
                "SELECT COALESCE(SUM(length(markdown_zstd)), 0)
                 FROM document_version_blobs WHERE document_id = ?1",
                params![document_id.as_str()],
                |row| row.get(0),
            )?;
            if store::from_ms(stored).saturating_add(compressed.len() as u64)
                > MAX_VERSION_BLOB_BYTES_PER_DOCUMENT
            {
                return Err(ApiError::bad_request("version storage limit reached"));
            }
            conn.execute(
                "INSERT INTO document_version_blobs
                    (document_id, content_hash, markdown_zstd, markdown_bytes, chars, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    document_id.as_str(),
                    content_hash.as_slice(),
                    compressed,
                    store::ms(markdown_bytes.len() as u64),
                    store::ms(chars),
                    store::ms(created_at),
                ],
            )?;
        }
        conn.execute(
            "INSERT INTO document_versions
                (id, document_id, content_hash, label, author_principal_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                version_id,
                document_id.as_str(),
                content_hash.as_slice(),
                label,
                author,
                store::ms(created_at),
            ],
        )?;
        Ok(())
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "version": {
                "id": version_id,
                "documentId": document_id.as_str(),
                "label": label,
                "author": author,
                "createdAt": created_at,
                "chars": chars,
            }
        })),
    )
        .into_response())
}

pub async fn version_get(
    State(app): State<Arc<App>>,
    Path((id, version)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let (metadata, compressed, expected_bytes, expected_hash) = app.db.read(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::Read)?;
        conn.query_row(
            "SELECT v.label, v.author_principal_id, v.created_at, b.chars,
                    b.markdown_zstd, b.markdown_bytes, b.content_hash
             FROM document_versions v
             JOIN document_version_blobs b
               ON b.document_id = v.document_id AND b.content_hash = v.content_hash
             WHERE v.id = ?1 AND v.document_id = ?2",
            params![version, document_id.as_str()],
            |row| {
                Ok((
                    json!({
                        "id": version,
                        "documentId": document_id.as_str(),
                        "label": row.get::<_, String>(0)?,
                        "author": row.get::<_, String>(1)?,
                        "createdAt": store::from_ms(row.get::<_, i64>(2)?),
                        "chars": store::from_ms(row.get::<_, i64>(3)?),
                    }),
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Vec<u8>>(6)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(ApiError::not_found)
    })?;
    let expected_bytes = usize::try_from(expected_bytes).map_err(|_| ApiError::internal())?;
    let markdown =
        zstd::bulk::decompress(&compressed, expected_bytes).map_err(|_| ApiError::internal())?;
    let actual_hash: [u8; 32] = Sha256::digest(&markdown).into();
    if markdown.len() != expected_bytes || expected_hash.as_slice() != actual_hash {
        tracing::error!(
            target: "marks_server::review",
            document = document_id.as_str(),
            version,
            "stored version failed integrity verification"
        );
        return Err(ApiError::internal());
    }
    let markdown = String::from_utf8(markdown).map_err(|_| ApiError::internal())?;
    Ok(Json(json!({ "version": metadata, "markdown": markdown })).into_response())
}

pub async fn version_delete(
    State(app): State<Arc<App>>,
    Path((id, version)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.tx(|conn| {
        let role = principal_role(conn, &cookie.session, &document_id)?;
        require_action(role, DocumentAction::EditText)?;
        let hash: Vec<u8> = conn
            .query_row(
                "SELECT content_hash FROM document_versions
                 WHERE id = ?1 AND document_id = ?2",
                params![version, document_id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(ApiError::not_found)?;
        conn.execute(
            "DELETE FROM document_versions WHERE id = ?1 AND document_id = ?2",
            params![version, document_id.as_str()],
        )?;
        conn.execute(
            "DELETE FROM document_version_blobs
             WHERE document_id = ?1 AND content_hash = ?2
               AND NOT EXISTS (
                 SELECT 1 FROM document_versions
                 WHERE document_id = ?1 AND content_hash = ?2
               )",
            params![document_id.as_str(), hash],
        )?;
        Ok(())
    })?;
    Ok(Json(json!({ "deleted": true })).into_response())
}
