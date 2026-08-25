//! Authenticated, bounded conversion into Markdown. Potentially hostile parser
//! work runs in a killable child process; URL imports pin every DNS resolution
//! to a public address.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::now_ms;
use crate::routes::documents::{Caller, caller};
use crate::routes::practical::{CheckError, parse_public_url, pinned_public_get};
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures_util::StreamExt;
use office_oxide::cfb::CfbReader;
use office_oxide::{Document, DocumentFormat};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::Instant;

/// The public edge accepts at most 12 MiB, so the application advertises and
/// enforces the same ceiling rather than a larger unreachable internal limit.
pub const MAX_IMPORT_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_URL_REQUEST_BYTES: usize = 4 * 1024;
const MAX_URL_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_URL_REDIRECTS: usize = 5;
const IMPORT_DEADLINE: Duration = Duration::from_secs(30);
const WORKER_REAP_RESERVE: Duration = Duration::from_secs(1);
const MAX_WORKER_HEADER_BYTES: usize = 8 * 1024;
const MAX_WORKER_STDERR_BYTES: usize = 64 * 1024;
const MAX_OFFICE_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OFFICE_PARTS: usize = 8_192;
const MAX_SHEETS: usize = 32;
const MAX_TABLE_ROWS: usize = 10_000;
const MAX_TABLE_COLUMNS: usize = 256;
const MAX_TABLE_CELLS: usize = 200_000;
const MAX_CELL_SCALARS: usize = 4_096;
#[cfg(unix)]
const WORKER_ADDRESS_SPACE_BYTES: libc::rlim_t = 512 * 1024 * 1024;
#[cfg(unix)]
const WORKER_CPU_SECONDS: libc::rlim_t = 25;
#[cfg(any(target_os = "linux", target_os = "android"))]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
type RlimitResource = libc::c_int;
// macOS does not enforce a usable address-space rlimit for spawned binaries;
// its data limit is attempted as defense in depth while the BIFF preflight is
// the allocation guard. Linux production enforces the whole address space.
#[cfg(target_os = "macos")]
const WORKER_MEMORY_RESOURCE: RlimitResource = libc::RLIMIT_DATA;
#[cfg(all(unix, not(target_os = "macos")))]
const WORKER_MEMORY_RESOURCE: RlimitResource = libc::RLIMIT_AS;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    title: String,
    markdown: String,
    kind: String,
    source_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UrlImportBody {
    url: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ImportFailure {
    Unsupported,
    Invalid,
    Empty,
    TooLarge,
}

/// Installed by route middleware before Axum begins extracting a request
/// body. Holding the permit across upload/fetch/conversion makes capacity
/// rejection immediate and gives every import one cumulative deadline.
pub struct ImportAdmission {
    deadline: Instant,
    _permit: OwnedSemaphorePermit,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum WorkerRequest {
    File {
        filename: String,
        max_units: usize,
    },
    Web {
        html_is_plain_text: bool,
        final_url: String,
        host_title: String,
        max_units: usize,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
enum WorkerResponse {
    Ok(ImportResult),
    Error(ImportFailure),
}

fn authorize_import(app: &App, headers: &HeaderMap) -> ApiResult<Caller> {
    let authority = caller(app, headers)?;
    if matches!(&authority, Caller::Principal(_)) {
        guard::require_same_origin(app, headers)?;
    }
    let key = match &authority {
        Caller::Principal(session) => format!("import:{}", session.principal_id().as_str()),
        Caller::Scratch(scratch) => format!("import:{}", scratch.as_str()),
    };
    if !app.rate.allow(&key, 20, 60_000, now_ms()) {
        return Err(ApiError::rate_limited());
    }
    Ok(authority)
}

/// Authenticate, rate-limit, and reserve conversion capacity before request
/// body extraction or any outbound URL work begins. The timeout wraps body
/// upload, redirects, streaming, conversion, and response construction as one
/// operation rather than resetting at each stage or redirect.
pub async fn admit(State(app): State<Arc<App>>, mut request: Request, next: Next) -> Response {
    let deadline = Instant::now() + IMPORT_DEADLINE;
    if let Err(error) = authorize_import(&app, request.headers()) {
        return error.into_response();
    }
    let permit = match app.import_jobs.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return ApiError::unavailable("import capacity exhausted").into_response(),
    };
    request.extensions_mut().insert(Arc::new(ImportAdmission {
        deadline,
        _permit: permit,
    }));
    match tokio::time::timeout_at(deadline, next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError::unavailable("import timed out").into_response(),
    }
}

fn import_error(error: ImportFailure) -> ApiError {
    match error {
        ImportFailure::Unsupported => ApiError::bad_request("unsupported import type"),
        ImportFailure::Invalid => ApiError::bad_request("document could not be read"),
        ImportFailure::Empty => ApiError::bad_request("document contains no importable text"),
        ImportFailure::TooLarge => ApiError::bad_request("converted document is too large"),
    }
}

/// Convert a browser-selected or dropped file. The endpoint returns Markdown;
/// the ordinary document-create transaction remains the only publication path.
pub async fn file(
    State(app): State<Arc<App>>,
    Extension(admission): Extension<Arc<ImportAdmission>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<Response> {
    if bytes.is_empty() {
        return Err(import_error(ImportFailure::Empty));
    }
    let filename = headers
        .get("x-marks-filename")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 240)
        .ok_or_else(|| ApiError::bad_request("missing import filename"))?
        .to_owned();
    let max_units = app.limits.max_document_units;
    let converted = run_worker(
        &app,
        &admission,
        WorkerRequest::File {
            filename,
            max_units,
        },
        bytes.to_vec(),
    )
    .await?
    .map_err(import_error)?;
    Ok(Json(converted).into_response())
}

/// Fetch a public web page and convert its static HTML to Markdown. Private,
/// local, link-local, documentation, and rebinding destinations fail closed.
pub async fn url(
    State(app): State<Arc<App>>,
    Extension(admission): Extension<Arc<ImportAdmission>>,
    Json(body): Json<UrlImportBody>,
) -> ApiResult<Response> {
    let mut current = parse_public_url(body.url.trim()).map_err(map_url_error)?;
    let mut response = None;
    for hop in 0..=MAX_URL_REDIRECTS {
        let next = pinned_public_get(&current).await.map_err(map_url_error)?;
        if !next.status().is_redirection() {
            response = Some(next);
            break;
        }
        if hop == MAX_URL_REDIRECTS {
            return Err(ApiError::bad_request("too many URL redirects"));
        }
        let location = next
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| ApiError::bad_request("URL redirect is invalid"))?;
        current = parse_public_url(
            current
                .join(location)
                .map_err(|_| ApiError::bad_request("URL redirect is invalid"))?
                .as_str(),
        )
        .map_err(map_url_error)?;
    }
    let response = response.ok_or_else(|| ApiError::unavailable("web page unavailable"))?;
    if !response.status().is_success() {
        return Err(if response.status() == StatusCode::NOT_FOUND {
            ApiError::not_found()
        } else {
            ApiError::unavailable("web page unavailable")
        });
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.starts_with("text/html")
        && !content_type.starts_with("application/xhtml+xml")
        && !content_type.starts_with("text/plain")
    {
        return Err(ApiError::bad_request("URL is not an HTML or text page"));
    }
    let bytes = bounded_body(response, MAX_URL_BODY_BYTES).await?;
    let html = String::from_utf8_lossy(&bytes).into_owned();
    let final_url = current.to_string();
    let host_title = current.host_str().unwrap_or("Imported page").to_owned();
    let plain = content_type.starts_with("text/plain");
    let max_units = app.limits.max_document_units;
    let converted = run_worker(
        &app,
        &admission,
        WorkerRequest::Web {
            html_is_plain_text: plain,
            final_url,
            host_title,
            max_units,
        },
        html.into_bytes(),
    )
    .await?
    .map_err(import_error)?;
    Ok(Json(converted).into_response())
}

fn map_url_error(error: CheckError) -> ApiError {
    match error {
        CheckError::Blocked => ApiError::bad_request("URL is not publicly reachable"),
        CheckError::Unavailable => ApiError::unavailable("web page unavailable"),
    }
}

async fn bounded_body(response: reqwest::Response, limit: usize) -> ApiResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ApiError::bad_request("web page is too large"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::unavailable("web page unavailable"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(ApiError::bad_request("web page is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn encode_worker_request(request: &WorkerRequest, body: Vec<u8>) -> ApiResult<Vec<u8>> {
    let header = serde_json::to_vec(request).map_err(|_| ApiError::internal())?;
    if header.len() > MAX_WORKER_HEADER_BYTES || body.len() > MAX_IMPORT_BYTES {
        return Err(ApiError::bad_request("import request is too large"));
    }
    let header_len = u32::try_from(header.len()).map_err(|_| ApiError::internal())?;
    let mut encoded = Vec::with_capacity(4 + header.len() + body.len());
    encoded.extend_from_slice(&header_len.to_be_bytes());
    encoded.extend_from_slice(&header);
    encoded.extend_from_slice(&body);
    Ok(encoded)
}

async fn read_worker_pipe(
    reader: impl AsyncRead + Unpin,
    limit: usize,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(std::io::Error::other(
            "import worker output exceeded its bound",
        ));
    }
    Ok(bytes)
}

async fn reap_worker(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    // `wait` is what releases the OS process-table entry. The child has
    // already received an unconditional kill, so this is cleanup, not work.
    let _ = child.wait().await;
}

async fn run_worker(
    app: &App,
    admission: &ImportAdmission,
    request: WorkerRequest,
    body: Vec<u8>,
) -> ApiResult<Result<ImportResult, ImportFailure>> {
    let max_units = match &request {
        WorkerRequest::File { max_units, .. } | WorkerRequest::Web { max_units, .. } => *max_units,
    };
    let input = encode_worker_request(&request, body)?;
    let executable = app
        .config
        .import_worker_path
        .clone()
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)
        .map_err(|_| ApiError::unavailable("import worker unavailable"))?;
    let mut command = Command::new(executable);
    command
        .arg("--import-worker-v1")
        .env_clear()
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_worker_resource_limits(&mut command)?;
    let mut child = command
        .spawn()
        .map_err(|_| ApiError::unavailable("import worker unavailable"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ApiError::unavailable("import worker unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ApiError::unavailable("import worker unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ApiError::unavailable("import worker unavailable"))?;

    let response_limit = max_units
        .saturating_mul(6)
        .saturating_add(MAX_WORKER_HEADER_BYTES);
    let mut writer = tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.shutdown().await
    });
    let mut stdout_reader = tokio::spawn(read_worker_pipe(stdout, response_limit));
    let mut stderr_reader = tokio::spawn(read_worker_pipe(stderr, MAX_WORKER_STDERR_BYTES));

    let worker_deadline = admission
        .deadline
        .checked_sub(WORKER_REAP_RESERVE)
        .unwrap_or(admission.deadline);
    if Instant::now() >= worker_deadline {
        reap_worker(&mut child).await;
        writer.abort();
        stdout_reader.abort();
        stderr_reader.abort();
        return Err(ApiError::unavailable("import timed out"));
    }
    let completed = tokio::time::timeout_at(worker_deadline, async {
        (&mut writer)
            .await
            .map_err(|_| ApiError::unavailable("import worker failed"))?
            .map_err(|_| ApiError::unavailable("import worker failed"))?;
        let status = child
            .wait()
            .await
            .map_err(|_| ApiError::unavailable("import worker failed"))?;
        let stdout = (&mut stdout_reader)
            .await
            .map_err(|_| ApiError::unavailable("import worker failed"))?
            .map_err(|_| ApiError::unavailable("import worker failed"))?;
        let _stderr = (&mut stderr_reader)
            .await
            .map_err(|_| ApiError::unavailable("import worker failed"))?
            .map_err(|_| ApiError::unavailable("import worker failed"))?;
        Ok::<_, ApiError>((status, stdout))
    })
    .await;

    let (status, stdout) = match completed {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            reap_worker(&mut child).await;
            writer.abort();
            stdout_reader.abort();
            stderr_reader.abort();
            let _ = writer.await;
            let _ = stdout_reader.await;
            let _ = stderr_reader.await;
            return Err(error);
        }
        Err(_) => {
            reap_worker(&mut child).await;
            writer.abort();
            stdout_reader.abort();
            stderr_reader.abort();
            let _ = writer.await;
            let _ = stdout_reader.await;
            let _ = stderr_reader.await;
            return Err(ApiError::unavailable("import timed out"));
        }
    };
    if !status.success() {
        return Err(ApiError::unavailable("import worker failed"));
    }
    match serde_json::from_slice::<WorkerResponse>(&stdout)
        .map_err(|_| ApiError::unavailable("import worker failed"))?
    {
        WorkerResponse::Ok(result) => Ok(Ok(result)),
        WorkerResponse::Error(error) => Ok(Err(error)),
    }
}

#[cfg(unix)]
fn configure_worker_resource_limits(command: &mut Command) -> ApiResult<()> {
    use std::os::unix::process::CommandExt;

    // SAFETY: the closure runs after fork and calls only async-signal-safe
    // libc resource-limit syscalls. It captures no shared runtime state.
    unsafe {
        command.as_std_mut().pre_exec(|| {
            #[cfg(target_os = "macos")]
            let _ = lower_soft_resource_limit(WORKER_MEMORY_RESOURCE, WORKER_ADDRESS_SPACE_BYTES);
            #[cfg(not(target_os = "macos"))]
            lower_soft_resource_limit(WORKER_MEMORY_RESOURCE, WORKER_ADDRESS_SPACE_BYTES)?;
            lower_soft_resource_limit(libc::RLIMIT_CPU, WORKER_CPU_SECONDS)
        });
    }
    Ok(())
}

#[cfg(not(unix))]
fn configure_worker_resource_limits(_command: &mut Command) -> ApiResult<()> {
    // Production runs on Unix, where the parser child has OS-enforced limits.
    // Other targets retain the killable process and absolute parent deadline.
    Ok(())
}

#[cfg(unix)]
fn lower_soft_resource_limit(
    resource: RlimitResource,
    ceiling: libc::rlim_t,
) -> std::io::Result<()> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: both calls receive valid pointers to a stack-owned rlimit.
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    current.rlim_cur = ceiling.min(current.rlim_max);
    if unsafe { libc::setrlimit(resource, &current) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Private child-process entry point. It deliberately initializes neither the
/// database nor tracing, inherits no environment, accepts one bounded framed
/// request, emits one bounded JSON response, and exits.
pub fn worker_main() -> i32 {
    let mut stdin = std::io::stdin().lock();
    let max_input = MAX_IMPORT_BYTES
        .saturating_add(MAX_WORKER_HEADER_BYTES)
        .saturating_add(4);
    let mut encoded = Vec::new();
    if stdin
        .by_ref()
        .take(max_input.saturating_add(1) as u64)
        .read_to_end(&mut encoded)
        .is_err()
        || encoded.len() > max_input
    {
        return 2;
    }
    let Some(header_bytes) = encoded.get(..4) else {
        return 2;
    };
    let header_len = u32::from_be_bytes(header_bytes.try_into().expect("four bytes")) as usize;
    if header_len == 0 || header_len > MAX_WORKER_HEADER_BYTES {
        return 2;
    }
    let Some(header_end) = 4_usize.checked_add(header_len) else {
        return 2;
    };
    let Some(header) = encoded.get(4..header_end) else {
        return 2;
    };
    let Some(body) = encoded.get(header_end..) else {
        return 2;
    };
    let Ok(request) = serde_json::from_slice::<WorkerRequest>(header) else {
        return 2;
    };
    let profile_limit = match crate::engine_profile::get() {
        Ok(profile) => profile.limits.max_document_units,
        Err(_) => return 2,
    };
    let converted = match request {
        WorkerRequest::File {
            filename,
            max_units,
        } if max_units > 0 && max_units <= profile_limit => {
            convert_file(&filename, body.to_vec(), max_units)
        }
        WorkerRequest::Web {
            html_is_plain_text,
            final_url,
            host_title,
            max_units,
        } if max_units > 0 && max_units <= profile_limit => {
            let html = String::from_utf8_lossy(body);
            convert_web_page(
                &html,
                html_is_plain_text,
                &final_url,
                &host_title,
                max_units,
            )
        }
        _ => return 2,
    };
    let response = match converted {
        Ok(result) => WorkerResponse::Ok(result),
        Err(error) => WorkerResponse::Error(error),
    };
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    if serde_json::to_writer(&mut stdout, &response).is_err() || stdout.flush().is_err() {
        return 2;
    }
    0
}

fn convert_file(
    filename: &str,
    bytes: Vec<u8>,
    max_units: usize,
) -> Result<ImportResult, ImportFailure> {
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or(ImportFailure::Unsupported)?;
    let (kind, markdown) = match extension.as_str() {
        "md" | "markdown" | "txt" => (
            "markdown",
            String::from_utf8(bytes).map_err(|_| ImportFailure::Invalid)?,
        ),
        "pdf" => {
            let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
                .map_err(|_| ImportFailure::Invalid)?;
            let pages = pages
                .into_iter()
                .map(|page| normalize_text(&page))
                .filter(|page| !page.trim().is_empty())
                .collect::<Vec<_>>();
            ("pdf", pages.join("\n\n---\n\n"))
        }
        "doc" => (
            "word",
            office_markdown(bytes, DocumentFormat::Doc, false, max_units)?,
        ),
        "docx" => {
            preflight_office_zip(&bytes)?;
            (
                "word",
                office_markdown(bytes, DocumentFormat::Docx, false, max_units)?,
            )
        }
        "xls" => {
            preflight_xls(&bytes)?;
            (
                "excel",
                office_markdown(bytes, DocumentFormat::Xls, true, max_units)?,
            )
        }
        "xlsx" => {
            preflight_office_zip(&bytes)?;
            (
                "excel",
                office_markdown(bytes, DocumentFormat::Xlsx, true, max_units)?,
            )
        }
        _ => return Err(ImportFailure::Unsupported),
    };
    let markdown = normalize_text(&markdown);
    validate_markdown(&markdown, max_units)?;
    Ok(ImportResult {
        title: title_from_filename(filename),
        markdown,
        kind: kind.to_owned(),
        source_url: None,
    })
}

/// Reject a BIFF sheet whose sparse coordinates would force office_oxide to
/// materialize a grid larger than the table contract. This runs before the
/// third-party parser allocates its `Vec<Vec<CellValue>>`.
fn preflight_xls(bytes: &[u8]) -> Result<(), ImportFailure> {
    let mut cfb = CfbReader::new(Cursor::new(bytes)).map_err(|_| ImportFailure::Invalid)?;
    let workbook = if cfb.has_stream("Workbook") {
        cfb.open_stream("Workbook")
    } else if cfb.has_stream("Book") {
        cfb.open_stream("Book")
    } else {
        return Err(ImportFailure::Invalid);
    }
    .map_err(|_| ImportFailure::Invalid)?;
    if workbook.len() as u64 > MAX_OFFICE_UNCOMPRESSED_BYTES {
        return Err(ImportFailure::TooLarge);
    }
    preflight_biff_table(&workbook)
}

fn preflight_biff_table(workbook: &[u8]) -> Result<(), ImportFailure> {
    const RT_BOF: u16 = 0x0809;
    const RT_EOF: u16 = 0x000a;
    const RT_BOUNDSHEET: u16 = 0x0085;
    const RT_DIMENSION: u16 = 0x0200;
    const RT_ROW: u16 = 0x0208;
    const CELL_RECORDS: &[u16] = &[
        0x0006, // FORMULA
        0x00d6, // RSTRING
        0x00fd, // LABELSST
        0x0201, // BLANK
        0x0203, // NUMBER
        0x0204, // LABEL
        0x0205, // BOOLERR
        0x027e, // RK
    ];
    const MULTI_CELL_RECORDS: &[u16] = &[0x00bd, 0x00be]; // MULRK, MULBLANK

    let mut position = 0_usize;
    let mut bound_sheets = 0_usize;
    let mut parsed_sheets = 0_usize;
    let mut in_sheet = false;
    let mut max_row = 0_usize;
    let mut max_column = 0_usize;
    let mut saw_cell = false;
    let mut records = 0_usize;

    while position.saturating_add(4) <= workbook.len() {
        records = records.saturating_add(1);
        if records > 500_000 {
            return Err(ImportFailure::TooLarge);
        }
        let record_type = u16::from_le_bytes([workbook[position], workbook[position + 1]]);
        let length = u16::from_le_bytes([workbook[position + 2], workbook[position + 3]]) as usize;
        position += 4;
        let end = position.checked_add(length).ok_or(ImportFailure::Invalid)?;
        let data = workbook.get(position..end).ok_or(ImportFailure::Invalid)?;
        position = end;

        if record_type == RT_BOUNDSHEET {
            bound_sheets = bound_sheets.saturating_add(1);
            if bound_sheets > MAX_SHEETS {
                return Err(ImportFailure::TooLarge);
            }
            continue;
        }
        if record_type == RT_BOF && data.len() >= 4 {
            let substream = u16::from_le_bytes([data[2], data[3]]);
            in_sheet = substream == 0x0010;
            if in_sheet {
                parsed_sheets = parsed_sheets.saturating_add(1);
                if parsed_sheets > MAX_SHEETS {
                    return Err(ImportFailure::TooLarge);
                }
                max_row = 0;
                max_column = 0;
                saw_cell = false;
            }
            continue;
        }
        if record_type == RT_EOF {
            in_sheet = false;
            continue;
        }
        if !in_sheet {
            continue;
        }

        if record_type == RT_DIMENSION && data.len() >= 12 {
            let rows =
                u32::from_le_bytes(data[4..8].try_into().map_err(|_| ImportFailure::Invalid)?)
                    as usize;
            let columns = u16::from_le_bytes(
                data[10..12]
                    .try_into()
                    .map_err(|_| ImportFailure::Invalid)?,
            ) as usize;
            validate_biff_extent(rows, columns)?;
        } else if CELL_RECORDS.contains(&record_type) && data.len() >= 4 {
            let row = u16::from_le_bytes([data[0], data[1]]) as usize;
            let column = u16::from_le_bytes([data[2], data[3]]) as usize;
            saw_cell = true;
            max_row = max_row.max(row);
            max_column = max_column.max(column);
            validate_biff_extent(max_row.saturating_add(1), max_column.saturating_add(1))?;
        } else if MULTI_CELL_RECORDS.contains(&record_type) && data.len() >= 6 {
            let row = u16::from_le_bytes([data[0], data[1]]) as usize;
            let first_column = u16::from_le_bytes([data[2], data[3]]) as usize;
            let last_column =
                u16::from_le_bytes([data[data.len() - 2], data[data.len() - 1]]) as usize;
            if last_column < first_column {
                return Err(ImportFailure::Invalid);
            }
            saw_cell = true;
            max_row = max_row.max(row);
            max_column = max_column.max(last_column);
            validate_biff_extent(max_row.saturating_add(1), max_column.saturating_add(1))?;
        } else if record_type == RT_ROW && data.len() >= 6 {
            let row = u16::from_le_bytes([data[0], data[1]]) as usize;
            let last_column = u16::from_le_bytes([data[4], data[5]]) as usize;
            if last_column > 0 {
                saw_cell = true;
                max_row = max_row.max(row);
                max_column = max_column.max(last_column - 1);
                validate_biff_extent(max_row.saturating_add(1), max_column.saturating_add(1))?;
            }
        }
    }
    if position != workbook.len() || (saw_cell && parsed_sheets == 0) {
        return Err(ImportFailure::Invalid);
    }
    Ok(())
}

fn validate_biff_extent(rows: usize, columns: usize) -> Result<(), ImportFailure> {
    if rows > MAX_TABLE_ROWS
        || columns > MAX_TABLE_COLUMNS
        || rows.saturating_mul(columns) > MAX_TABLE_CELLS
    {
        return Err(ImportFailure::TooLarge);
    }
    Ok(())
}

fn office_markdown(
    bytes: Vec<u8>,
    format: DocumentFormat,
    table_only: bool,
    max_units: usize,
) -> Result<String, ImportFailure> {
    let document =
        Document::from_reader(Cursor::new(bytes), format).map_err(|_| ImportFailure::Invalid)?;
    if !table_only {
        return Ok(document.to_markdown());
    }
    match format {
        DocumentFormat::Xlsx => {
            render_xlsx(document.as_xlsx().ok_or(ImportFailure::Invalid)?, max_units)
        }
        DocumentFormat::Xls => {
            render_xls(document.as_xls().ok_or(ImportFailure::Invalid)?, max_units)
        }
        _ => Err(ImportFailure::Unsupported),
    }
}

fn preflight_office_zip(bytes: &[u8]) -> Result<(), ImportFailure> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| ImportFailure::Invalid)?;
    if archive.len() > MAX_OFFICE_PARTS {
        return Err(ImportFailure::TooLarge);
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| ImportFailure::Invalid)?;
        expanded = expanded
            .checked_add(entry.size())
            .ok_or(ImportFailure::TooLarge)?;
        if expanded > MAX_OFFICE_UNCOMPRESSED_BYTES {
            return Err(ImportFailure::TooLarge);
        }
    }
    Ok(())
}

fn render_xlsx(
    workbook: &office_oxide::xlsx::XlsxDocument,
    max_units: usize,
) -> Result<String, ImportFailure> {
    if workbook.worksheets.len() > MAX_SHEETS {
        return Err(ImportFailure::TooLarge);
    }
    let mut output = String::new();
    let mut total_rows = 0_usize;
    let mut total_cells = 0_usize;
    for worksheet in &workbook.worksheets {
        let mut rows = Vec::new();
        for row in &worksheet.rows {
            total_rows = total_rows.saturating_add(1);
            if total_rows > MAX_TABLE_ROWS {
                return Err(ImportFailure::TooLarge);
            }
            let width = row
                .cells
                .iter()
                .map(|cell| cell.reference.col as usize + 1)
                .max()
                .unwrap_or(0);
            if width > MAX_TABLE_COLUMNS {
                return Err(ImportFailure::TooLarge);
            }
            total_cells = total_cells.saturating_add(width);
            if total_cells > MAX_TABLE_CELLS {
                return Err(ImportFailure::TooLarge);
            }
            let mut values = vec![String::new(); width];
            for cell in &row.cells {
                let column = cell.reference.col as usize;
                if column < width {
                    // Only the cached display value is imported. Formula text,
                    // drawings, charts, macros, and workbook code are ignored.
                    values[column] = workbook.format_cell_value(cell);
                }
            }
            rows.push(values);
        }
        render_sheet(&mut output, &worksheet.name, &rows, max_units)?;
    }
    Ok(output)
}

fn render_xls(
    workbook: &office_oxide::xls::XlsDocument,
    max_units: usize,
) -> Result<String, ImportFailure> {
    if workbook.sheets.len() > MAX_SHEETS {
        return Err(ImportFailure::TooLarge);
    }
    let mut output = String::new();
    let mut total_rows = 0_usize;
    let mut total_cells = 0_usize;
    for sheet in &workbook.sheets {
        let mut rows = Vec::new();
        for row in &sheet.rows {
            total_rows = total_rows.saturating_add(1);
            if total_rows > MAX_TABLE_ROWS || row.len() > MAX_TABLE_COLUMNS {
                return Err(ImportFailure::TooLarge);
            }
            total_cells = total_cells.saturating_add(row.len());
            if total_cells > MAX_TABLE_CELLS {
                return Err(ImportFailure::TooLarge);
            }
            rows.push(row.iter().map(|cell| cell.as_text()).collect());
        }
        render_sheet(&mut output, &sheet.name, &rows, max_units)?;
    }
    Ok(output)
}

fn render_sheet(
    output: &mut String,
    name: &str,
    rows: &[Vec<String>],
    max_units: usize,
) -> Result<(), ImportFailure> {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    if columns == 0 {
        return Ok(());
    }
    if !output.is_empty() {
        push_bounded(output, "\n\n", max_units)?;
    }
    push_bounded(
        output,
        &format!("## {}\n\n", normalize_heading(name)),
        max_units,
    )?;
    let header = rows.first().ok_or(ImportFailure::Empty)?;
    let header = (0..columns)
        .map(|column| {
            let value = header.get(column).map(String::as_str).unwrap_or("");
            if value.trim().is_empty() {
                format!("Column {}", column + 1)
            } else {
                escape_cell(value)
            }
        })
        .collect::<Vec<_>>();
    push_bounded(output, &format!("| {} |\n", header.join(" | ")), max_units)?;
    push_bounded(
        output,
        &format!("| {} |\n", vec!["---"; columns].join(" | ")),
        max_units,
    )?;
    for row in rows.iter().skip(1) {
        let values = (0..columns)
            .map(|column| escape_cell(row.get(column).map(String::as_str).unwrap_or("")))
            .collect::<Vec<_>>();
        push_bounded(output, &format!("| {} |\n", values.join(" | ")), max_units)?;
    }
    Ok(())
}

fn push_bounded(output: &mut String, value: &str, max_units: usize) -> Result<(), ImportFailure> {
    let max_bytes = max_units.saturating_mul(4);
    if output.len().saturating_add(value.len()) > max_bytes {
        return Err(ImportFailure::TooLarge);
    }
    output.push_str(value);
    Ok(())
}

fn escape_cell(value: &str) -> String {
    value
        .chars()
        .take(MAX_CELL_SCALARS)
        .filter(|character| !character.is_control() || matches!(*character, '\n' | '\r' | '\t'))
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace(['\r', '\n'], "<br>")
        .trim()
        .to_owned()
}

fn normalize_heading(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(160)
        .collect::<String>()
        .trim()
        .trim_start_matches('#')
        .trim()
        .to_owned()
}

fn convert_web_page(
    html: &str,
    plain: bool,
    source_url: &str,
    host_title: &str,
    max_units: usize,
) -> Result<ImportResult, ImportFailure> {
    let title = if plain {
        host_title.to_owned()
    } else {
        title_from_html(html).unwrap_or_else(|| host_title.to_owned())
    };
    let content = if plain {
        normalize_text(html)
    } else {
        let converter = htmd::HtmlToMarkdown::builder()
            .skip_tags(vec![
                "script", "style", "noscript", "template", "svg", "canvas", "iframe",
            ])
            .build();
        normalize_text(
            &converter
                .convert(html)
                .map_err(|_| ImportFailure::Invalid)?,
        )
    };
    if content.trim().is_empty() {
        return Err(ImportFailure::Empty);
    }
    let markdown = format!("> Imported from <{source_url}>\n\n{content}");
    validate_markdown(&markdown, max_units)?;
    Ok(ImportResult {
        title: clean_title(&title),
        markdown,
        kind: "url".to_owned(),
        source_url: Some(source_url.to_owned()),
    })
}

fn normalize_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|character| !character.is_control() || matches!(*character, '\n' | '\t'))
        .collect::<String>()
        .trim()
        .to_owned()
}

fn validate_markdown(markdown: &str, max_units: usize) -> Result<(), ImportFailure> {
    if markdown.trim().is_empty() {
        return Err(ImportFailure::Empty);
    }
    if markdown.encode_utf16().count() > max_units {
        return Err(ImportFailure::TooLarge);
    }
    Ok(())
}

fn title_from_filename(filename: &str) -> String {
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename);
    clean_title(&stem.replace(['_', '-'], " "))
}

fn title_from_html(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let title_start = lower.find("<title")?;
    let content_start = lower[title_start..].find('>')? + title_start + 1;
    let content_end = lower[content_start..].find("</title>")? + content_start;
    let title = html.get(content_start..content_end)?;
    Some(clean_title(
        &title
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'"),
    ))
}

fn clean_title(value: &str) -> String {
    let title = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|character| !character.is_control())
        .take(160)
        .collect::<String>();
    if title.is_empty() {
        "Imported document".to_owned()
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_worker_is_killed_and_reaped() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        reap_worker(&mut child).await;
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn spreadsheet_rendering_emits_only_bounded_pipe_tables() {
        let rows = vec![
            vec!["Name".into(), "Amount".into()],
            vec!["A | B".into(), "first\nsecond".into()],
        ];
        let mut output = String::new();
        render_sheet(&mut output, "Sheet #1", &rows, 10_000).unwrap();
        assert_eq!(
            output,
            "## Sheet #1\n\n| Name | Amount |\n| --- | --- |\n| A \\| B | first<br>second |\n"
        );
    }

    #[test]
    fn xlsx_import_keeps_cached_cells_but_never_formula_source() {
        use office_oxide::xlsx::write::{CellData, XlsxWriter};

        let mut workbook = XlsxWriter::new();
        let mut sheet = workbook.add_sheet("Sales");
        sheet.set_cell(0, 0, CellData::String("Item".into()));
        sheet.set_cell(0, 1, CellData::String("Amount".into()));
        sheet.set_cell(1, 0, CellData::String("Widget".into()));
        sheet.set_cell(1, 1, CellData::Number(1500.0));
        sheet.set_cell(2, 0, CellData::String("Total".into()));
        sheet.set_cell(2, 1, CellData::Formula("SUM(B2:B2)".into()));
        let mut bytes = Cursor::new(Vec::new());
        workbook.write_to(&mut bytes).unwrap();

        let imported = convert_file("sales.xlsx", bytes.into_inner(), 100_000).unwrap();
        assert!(imported.markdown.contains("| Item | Amount |"));
        assert!(imported.markdown.contains("| Widget | 1500 |"));
        assert!(!imported.markdown.contains("SUM("));
    }

    #[test]
    fn sparse_legacy_xls_coordinates_are_rejected_before_grid_allocation() {
        fn record(kind: u16, body: &[u8]) -> Vec<u8> {
            let mut bytes = Vec::with_capacity(body.len() + 4);
            bytes.extend_from_slice(&kind.to_le_bytes());
            bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
            bytes.extend_from_slice(body);
            bytes
        }

        let mut workbook = record(0x0809, &[0x00, 0x06, 0x10, 0x00]);
        // A single NUMBER at BIFF's maximum row/column used to make the
        // pinned parser allocate 16,777,216 CellValues before Marks rejected
        // the resulting table.
        let mut number = Vec::new();
        number.extend_from_slice(&u16::MAX.to_le_bytes());
        number.extend_from_slice(&255_u16.to_le_bytes());
        number.extend_from_slice(&0_u16.to_le_bytes());
        number.extend_from_slice(&0_f64.to_le_bytes());
        workbook.extend(record(0x0203, &number));
        workbook.extend(record(0x000a, &[]));

        assert!(matches!(
            preflight_biff_table(&workbook),
            Err(ImportFailure::TooLarge)
        ));
    }

    #[test]
    fn docx_import_preserves_markdown_structure() {
        let mut bytes = Cursor::new(Vec::new());
        office_oxide::create::create_from_markdown_to_writer(
            "# Brief\n\nA **bold** sentence.",
            DocumentFormat::Docx,
            &mut bytes,
        )
        .unwrap();
        let imported = convert_file("brief.docx", bytes.into_inner(), 100_000).unwrap();
        assert!(imported.markdown.contains("# Brief"));
        assert!(imported.markdown.contains("**bold**"));
    }

    #[test]
    fn html_import_drops_active_content_and_keeps_source_receipt() {
        let result = convert_web_page(
            "<html><head><title>Example &amp; Co</title><style>x</style></head><body><h1>Hello</h1><script>alert(1)</script><p>World</p></body></html>",
            false,
            "https://example.com/page",
            "example.com",
            10_000,
        )
        .unwrap();
        assert_eq!(result.title, "Example & Co");
        assert!(result.markdown.contains("# Hello"));
        assert!(result.markdown.contains("World"));
        assert!(!result.markdown.contains("alert"));
        assert!(
            result
                .markdown
                .starts_with("> Imported from <https://example.com/page>")
        );
    }

    #[test]
    fn filenames_become_plain_catalog_titles() {
        assert_eq!(
            title_from_filename("quarterly_report-final.xlsx"),
            "quarterly report final"
        );
    }
}
