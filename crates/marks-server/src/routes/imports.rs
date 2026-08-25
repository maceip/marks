//! Authenticated, bounded conversion into Markdown. Local Office/PDF bytes
//! stay in-process; URL imports pin every DNS resolution to a public address.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::now_ms;
use crate::routes::documents::{Caller, caller};
use crate::routes::practical::{CheckError, parse_public_url, pinned_public_get};
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use office_oxide::{Document, DocumentFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::Arc;

pub const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_URL_REQUEST_BYTES: usize = 4 * 1024;
const MAX_URL_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_URL_REDIRECTS: usize = 5;
const MAX_OFFICE_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OFFICE_PARTS: usize = 8_192;
const MAX_SHEETS: usize = 32;
const MAX_TABLE_ROWS: usize = 10_000;
const MAX_TABLE_COLUMNS: usize = 256;
const MAX_TABLE_CELLS: usize = 200_000;
const MAX_CELL_SCALARS: usize = 4_096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    title: String,
    markdown: String,
    kind: &'static str,
    source_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UrlImportBody {
    url: String,
}

#[derive(Debug)]
enum ImportFailure {
    Unsupported,
    Invalid,
    Empty,
    TooLarge,
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
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<Response> {
    let _authority = authorize_import(&app, &headers)?;
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
    let permit = app
        .import_jobs
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::unavailable("import worker unavailable"))?;
    let converted = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        convert_file(&filename, bytes.to_vec(), max_units)
    })
    .await
    .map_err(|_| ApiError::unavailable("import worker failed"))?
    .map_err(import_error)?;
    Ok(Json(converted).into_response())
}

/// Fetch a public web page and convert its static HTML to Markdown. Private,
/// local, link-local, documentation, and rebinding destinations fail closed.
pub async fn url(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<UrlImportBody>,
) -> ApiResult<Response> {
    let _authority = authorize_import(&app, &headers)?;
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
    let permit = app
        .import_jobs
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::unavailable("import worker unavailable"))?;
    let converted = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        convert_web_page(&html, plain, &final_url, &host_title, max_units)
    })
    .await
    .map_err(|_| ApiError::unavailable("import worker failed"))?
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
        "xls" => (
            "excel",
            office_markdown(bytes, DocumentFormat::Xls, true, max_units)?,
        ),
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
        kind,
        source_url: None,
    })
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
        kind: "url",
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
