//! Authorized asset ingestion backed by a bounded content-addressed store.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::{new_id, now_ms};
use crate::routes::documents::{
    Caller, caller, document_text, load_live_document, resolve_caller_role,
};
use crate::store;
use aho_corasick::AhoCorasick;
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use marks_auth::{DocumentAction, DocumentId, authorize_document_action};
use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::io::ReaderStream;

const MAX_ASSETS_PER_DOCUMENT: u64 = 1_000;
const BUNDLE_CHUNK_BYTES: usize = 128 * 1024;
const BUNDLE_CHANNEL_DEPTH: usize = 8;

#[derive(Clone)]
struct AssetRow {
    id: String,
    filename: String,
    media_type: String,
    bytes: u64,
    hash: [u8; 32],
}

fn require_write(
    conn: &rusqlite::Connection,
    caller: &Caller,
    document_id: &DocumentId,
) -> ApiResult<()> {
    let row = load_live_document(conn, document_id)?;
    if let Some(role) = resolve_caller_role(conn, caller, &row)?
        && !authorize_document_action(role, DocumentAction::EditText)
    {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

fn load_asset(
    conn: &rusqlite::Connection,
    document_id: &DocumentId,
    asset_id: &str,
) -> ApiResult<AssetRow> {
    conn.query_row(
        "SELECT a.id, a.filename, b.media_type, b.bytes, b.content_hash
         FROM document_assets a
         JOIN asset_blobs b ON b.content_hash = a.content_hash
         WHERE a.id = ?1 AND a.document_id = ?2",
        params![asset_id, document_id.as_str()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Vec<u8>>(4)?,
            ))
        },
    )
    .optional()?
    .map(
        |(id, filename, media_type, bytes, hash)| -> ApiResult<AssetRow> {
            Ok(AssetRow {
                id,
                filename,
                media_type,
                bytes: store::from_ms(bytes),
                hash: store::hash32(hash)?,
            })
        },
    )
    .transpose()?
    .ok_or_else(ApiError::not_found)
}

fn asset_json(document_id: &DocumentId, asset: &AssetRow) -> serde_json::Value {
    json!({
        "id": asset.id,
        "url": format!("/a/{}/{}", document_id.as_str(), asset.id),
        "filename": asset.filename,
        "mediaType": asset.media_type,
        "bytes": asset.bytes,
    })
}

pub async fn upload(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    if matches!(caller, Caller::Principal(_)) {
        guard::require_same_origin(&app, &headers)?;
    }
    if body.is_empty() || body.len() > app.config.max_asset_bytes {
        return Err(ApiError::bad_request("asset exceeds the upload limit"));
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let media_type = sniff_image_type(&body)
        .ok_or_else(|| ApiError::bad_request("unsupported or invalid image"))?;
    let filename = safe_filename(
        headers
            .get("x-marks-filename")
            .and_then(|value| value.to_str().ok()),
        media_type,
    )?;
    let hash: [u8; 32] = Sha256::digest(&body).into();
    let _mutation_guard = app.assets.mutation_guard().await;
    let _content_guard = app.assets.content_guard(hash).await;

    let (existing, count, stored) = app.db.read(|conn| {
        require_write(conn, &caller, &document_id)?;
        let existing = conn
            .query_row(
                "SELECT id FROM document_assets WHERE document_id = ?1 AND content_hash = ?2",
                params![document_id.as_str(), hash.as_slice()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|id| load_asset(conn, &document_id, &id))
            .transpose()?;
        let (count, stored): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(b.bytes), 0)
             FROM document_assets a
             JOIN asset_blobs b ON b.content_hash = a.content_hash
             WHERE a.document_id = ?1",
            params![document_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((existing, store::from_ms(count), store::from_ms(stored)))
    })?;
    if let Some(existing) = existing {
        return Ok(Json(json!({ "asset": asset_json(&document_id, &existing) })).into_response());
    }
    if count >= MAX_ASSETS_PER_DOCUMENT
        || stored.saturating_add(body.len() as u64) > app.config.max_asset_bytes_per_document
    {
        return Err(ApiError::bad_request("document asset quota reached"));
    }

    // The byte publication precedes its DB reference. A crash can therefore
    // leave only an unreferenced content hash (safe to sweep), never metadata
    // pointing at a partial file.
    app.assets.put(hash, body.clone()).await?;
    let proposed_id = new_id("asset");
    let created_at = now_ms();
    let (actor_kind, actor_id) = match &caller {
        Caller::Principal(session) => ("principal", session.principal_id().as_str()),
        Caller::Scratch(scratch) => ("scratch", scratch.as_str()),
    };
    let asset = app.db.tx(|conn| {
        require_write(conn, &caller, &document_id)?;
        let (count, stored): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(b.bytes), 0)
             FROM document_assets a
             JOIN asset_blobs b ON b.content_hash = a.content_hash
             WHERE a.document_id = ?1",
            params![document_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if store::from_ms(count) >= MAX_ASSETS_PER_DOCUMENT
            || store::from_ms(stored).saturating_add(body.len() as u64)
                > app.config.max_asset_bytes_per_document
        {
            return Err(ApiError::bad_request("document asset quota reached"));
        }
        conn.execute(
            "INSERT OR IGNORE INTO asset_blobs
                (content_hash, bytes, media_type, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                hash.as_slice(),
                store::ms(body.len() as u64),
                media_type,
                store::ms(created_at)
            ],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO document_assets
                (id, document_id, content_hash, filename, actor_kind, actor_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                proposed_id,
                document_id.as_str(),
                hash.as_slice(),
                filename,
                actor_kind,
                actor_id,
                store::ms(created_at)
            ],
        )?;
        let id = conn.query_row(
            "SELECT id FROM document_assets WHERE document_id = ?1 AND content_hash = ?2",
            params![document_id.as_str(), hash.as_slice()],
            |row| row.get::<_, String>(0),
        )?;
        load_asset(conn, &document_id, &id)
    });
    let asset = match asset {
        Ok(asset) => asset,
        Err(error) => {
            // The final transaction remains authoritative under concurrent
            // quota races. Roll back bytes only while the same-hash gate is
            // held and only when no document managed to publish a reference.
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
            if matches!(referenced, Ok(false))
                && let Err(cleanup_error) = app.assets.remove(hash).await
            {
                tracing::warn!(
                    target: "marks_server::assets",
                    ?cleanup_error,
                    "could not roll back unreferenced upload bytes"
                );
            }
            return Err(error);
        }
    };
    Ok((
        StatusCode::CREATED,
        Json(json!({ "asset": asset_json(&document_id, &asset) })),
    )
        .into_response())
}

/// Asset IDs are 128-bit document-scoped read capabilities embedded in the
/// Markdown. The document must still be live, so trash revokes the URL. This
/// lets scratch documents render ordinary image links without putting a
/// workspace bearer token in query strings or referrers.
pub async fn get(
    State(app): State<Arc<App>>,
    Path((document, asset)): Path<(String, String)>,
) -> ApiResult<Response> {
    let document_id = DocumentId::new(document).map_err(|_| ApiError::not_found())?;
    let mutation_guard = app.assets.mutation_guard().await;
    let row = app.db.read(|conn| {
        load_live_document(conn, &document_id)?;
        load_asset(conn, &document_id, &asset)
    })?;
    let file = app
        .assets
        .open_stream(
            row.hash,
            usize::try_from(row.bytes).map_err(|_| ApiError::internal())?,
        )
        .await?;
    drop(mutation_guard);
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&row.media_type).map_err(|_| ApiError::internal())?,
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&row.bytes.to_string()).map_err(|_| ApiError::internal())?,
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600, must-revalidate"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"{}\"", row.filename))
            .map_err(|_| ApiError::internal())?,
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", hash_hex(&row.hash)))
            .map_err(|_| ApiError::internal())?,
    );
    Ok(response)
}

/// Portable ZIP: canonical Markdown plus every document asset it actually
/// references, with URLs rewritten to relative `assets/` paths.
pub async fn export_bundle(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = caller(&app, &headers)?;
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    let export_permit = app
        .bundle_exports
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable("portable export capacity reached"))?;
    let mutation_guard = app.assets.mutation_guard().await;
    let markdown = document_text(&app, &caller, &document_id).await?;
    let rows = app.db.read(|conn| {
        let row = load_live_document(conn, &document_id)?;
        resolve_caller_role(conn, &caller, &row)?;
        let mut statement = conn.prepare(
            "SELECT a.id FROM document_assets a
             WHERE a.document_id = ?1 ORDER BY a.created_at ASC",
        )?;
        let ids = statement
            .query_map(params![document_id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| load_asset(conn, &document_id, &id))
            .collect::<ApiResult<Vec<_>>>()
    })?;
    let (markdown, bundled) = select_bundle_assets(markdown, &document_id, rows)?;

    let manifest = json!({
        "schema": "marks-portable-bundle",
        "version": 1,
        "documentId": document_id.as_str(),
        "assets": bundled.iter().map(|asset| json!({
            "id": asset.row.id,
            "path": asset.path,
            "filename": asset.row.filename,
            "mediaType": asset.row.media_type,
            "bytes": asset.row.bytes,
            "sha256": hash_hex(&asset.row.hash),
        })).collect::<Vec<_>>(),
    });
    let mut encoded_manifest =
        serde_json::to_vec_pretty(&manifest).map_err(|_| ApiError::internal())?;
    encoded_manifest.push(b'\n');

    // Fail before committing response headers if an immutable asset is
    // missing or corrupt. This verification is constant-memory; the shared
    // mutation guard then prevents a purge until the stream finishes.
    let verification_store = app.assets.clone();
    let verification_assets = bundled
        .iter()
        .map(|asset| (asset.row.hash, asset.expected_bytes))
        .collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || {
        for (hash, expected_bytes) in verification_assets {
            verification_store.verify_content(hash, expected_bytes)?;
        }
        Ok::<(), io::Error>(())
    })
    .await
    .map_err(|_| ApiError::internal())?
    .map_err(|error| {
        tracing::error!(target: "marks_server::assets", %error, "portable export asset verification failed");
        ApiError::internal()
    })?;

    let (sender, receiver) = mpsc::channel(BUNDLE_CHANNEL_DEPTH);
    let error_sender = sender.clone();
    let stream_store = app.assets.clone();
    tokio::task::spawn_blocking(move || {
        let _export_permit = export_permit;
        let _mutation_guard = mutation_guard;
        if let Err(error) = write_bundle(
            BundleBodyWriter::new(sender),
            &markdown,
            &encoded_manifest,
            bundled,
            &stream_store,
        ) {
            tracing::error!(target: "marks_server::assets", %error, "portable export stream failed");
            let _ = error_sender.blocking_send(Err(error));
        }
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"marks-document.zip\""),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

struct BundleAsset {
    row: AssetRow,
    path: String,
    expected_bytes: usize,
}

/// Rewrite every referenced capability URL in one Aho-Corasick pass. The old
/// nested `contains` + `replace` loop scanned the whole Markdown once per
/// stored asset (up to 1,000 scans for a large document).
fn select_bundle_assets(
    markdown: String,
    document_id: &DocumentId,
    rows: Vec<AssetRow>,
) -> ApiResult<(String, Vec<BundleAsset>)> {
    if rows.is_empty() {
        return Ok((markdown, Vec::new()));
    }
    let urls = rows
        .iter()
        .map(|row| format!("/a/{}/{}", document_id.as_str(), row.id))
        .collect::<Vec<_>>();
    let paths = rows
        .iter()
        .map(|row| format!("assets/{}.{}", row.id, extension_for(&row.media_type)))
        .collect::<Vec<_>>();
    let matcher = AhoCorasick::new(&urls).map_err(|_| ApiError::internal())?;
    let mut used = vec![false; rows.len()];
    let mut rewritten = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for matched in matcher.find_iter(markdown.as_bytes()) {
        let index = matched.pattern().as_usize();
        rewritten.push_str(&markdown[cursor..matched.start()]);
        rewritten.push_str(&paths[index]);
        used[index] = true;
        cursor = matched.end();
    }
    rewritten.push_str(&markdown[cursor..]);
    let bundled = rows
        .into_iter()
        .zip(paths)
        .enumerate()
        .filter_map(|(index, (row, path))| {
            used[index].then(|| {
                let expected_bytes =
                    usize::try_from(row.bytes).map_err(|_| ApiError::internal())?;
                Ok(BundleAsset {
                    row,
                    path,
                    expected_bytes,
                })
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok((rewritten, bundled))
}

fn write_bundle(
    writer: BundleBodyWriter,
    markdown: &str,
    manifest: &[u8],
    bundled: Vec<BundleAsset>,
    store: &crate::assets::AssetStore,
) -> io::Result<()> {
    let mut zip = zip::ZipWriter::new_stream(writer);
    let text_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let binary_options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("document.md", text_options)
        .map_err(zip_to_io)?;
    zip.write_all(markdown.as_bytes())?;
    zip.start_file("manifest.json", text_options)
        .map_err(zip_to_io)?;
    zip.write_all(manifest)?;
    for asset in bundled {
        zip.start_file(asset.path, binary_options)
            .map_err(zip_to_io)?;
        let mut file = store.open_verified_content(asset.row.hash, asset.expected_bytes)?;
        let copied = io::copy(&mut file, &mut zip)?;
        if copied != asset.row.bytes {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "asset changed while writing portable export",
            ));
        }
    }
    let stream = zip.finish().map_err(zip_to_io)?;
    stream.into_inner().finish()
}

fn zip_to_io(error: zip::result::ZipError) -> io::Error {
    io::Error::other(error)
}

struct BundleBodyWriter {
    sender: mpsc::Sender<Result<Bytes, io::Error>>,
    buffer: Vec<u8>,
}

impl BundleBodyWriter {
    fn new(sender: mpsc::Sender<Result<Bytes, io::Error>>) -> Self {
        Self {
            sender,
            buffer: Vec::with_capacity(BUNDLE_CHUNK_BYTES),
        }
    }

    fn send_buffer(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let bytes = Bytes::from(std::mem::replace(
            &mut self.buffer,
            Vec::with_capacity(BUNDLE_CHUNK_BYTES),
        ));
        self.sender.blocking_send(Ok(bytes)).map_err(|_| {
            io::Error::new(io::ErrorKind::BrokenPipe, "portable export receiver closed")
        })
    }

    fn finish(mut self) -> io::Result<()> {
        self.send_buffer()
    }
}

impl Write for BundleBodyWriter {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let written = bytes.len();
        while !bytes.is_empty() {
            let remaining = BUNDLE_CHUNK_BYTES - self.buffer.len();
            let take = remaining.min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.buffer.len() == BUNDLE_CHUNK_BYTES {
                self.send_buffer()?;
            }
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.send_buffer()
    }
}

fn safe_filename(value: Option<&str>, media_type: &str) -> ApiResult<String> {
    let fallback = format!("image.{}", extension_for(media_type));
    let value = value.unwrap_or(&fallback).trim();
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b' '))
    {
        return Err(ApiError::bad_request("invalid asset filename"));
    }
    Ok(value.to_owned())
}

pub(crate) fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub(crate) fn extension_for(media_type: &str) -> &'static str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

pub(crate) fn hash_hex(hash: &[u8; 32]) -> String {
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_sniffing_ignores_claimed_mime() {
        assert_eq!(
            sniff_image_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(sniff_image_type(b"<svg onload=alert(1)>"), None);
    }
}
