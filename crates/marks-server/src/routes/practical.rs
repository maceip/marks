//! Explicit, document-authorized network lookups used by practical ribbon
//! inspectors. Neither endpoint accepts or transmits document Markdown.

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::now_ms;
use crate::routes::documents::{Caller, caller, load_live_document, resolve_caller_role};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use futures_util::{StreamExt, stream};
use marks_auth::{DocumentAction, DocumentId, authorize_document_action};
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

const MAX_LINKS: usize = 32;
const MAX_URL_BYTES: usize = 2_048;
const MAX_REDIRECTS: usize = 3;
const MAX_CROSSREF_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkCheckBody {
    urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CitationLookupBody {
    doi: String,
}

fn authorize_lookup(app: &App, headers: &HeaderMap, id: String) -> ApiResult<(Caller, DocumentId)> {
    let authority = caller(app, headers)?;
    if matches!(authority, Caller::Principal(_)) {
        guard::require_same_origin(app, headers)?;
        let cookie = guard::cookie_session(app, headers)?;
        guard::require_csrf(headers, &cookie.secret)?;
    }
    let document_id = DocumentId::new(id).map_err(|_| ApiError::not_found())?;
    app.db.read(|connection| {
        let row = load_live_document(connection, &document_id)?;
        if let Some(role) = resolve_caller_role(connection, &authority, &row)?
            && !authorize_document_action(role, DocumentAction::Read)
        {
            return Err(ApiError::not_found());
        }
        Ok(())
    })?;
    let rate_key = match &authority {
        Caller::Principal(session) => format!("practical:{}", session.principal_id().as_str()),
        Caller::Scratch(scratch) => format!("practical:{}", scratch.as_str()),
    };
    if !app.rate.allow(&rate_key, 30, 60_000, now_ms()) {
        return Err(ApiError::rate_limited());
    }
    Ok((authority, document_id))
}

pub async fn check_links(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<LinkCheckBody>,
) -> ApiResult<Response> {
    let _ = authorize_lookup(&app, &headers, id)?;
    if body.urls.is_empty() || body.urls.len() > MAX_LINKS {
        return Err(ApiError::bad_request("link check count is invalid"));
    }
    let mut urls = Vec::with_capacity(body.urls.len());
    for raw in body.urls {
        if raw.len() > MAX_URL_BYTES || urls.iter().any(|value: &String| value == &raw) {
            return Err(ApiError::bad_request("link check URL is invalid"));
        }
        urls.push(raw);
    }
    let checks = stream::iter(
        urls.into_iter()
            .map(|url| async move { check_url(url).await }),
    )
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    Ok(Json(json!({ "checks": checks })).into_response())
}

pub async fn citation_lookup(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CitationLookupBody>,
) -> ApiResult<Response> {
    let _ = authorize_lookup(&app, &headers, id)?;
    let doi = normalize_doi(&body.doi).ok_or_else(|| ApiError::bad_request("invalid DOI"))?;
    let mut url =
        Url::parse("https://api.crossref.org/works/").map_err(|_| ApiError::internal())?;
    url.path_segments_mut()
        .map_err(|_| ApiError::internal())?
        .push(&doi);
    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| ApiError::internal())?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "Marks/0.1 (citation lookup)")
        .send()
        .await
        .map_err(|_| ApiError::unavailable("citation provider unavailable"))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(ApiError::not_found());
    }
    if response.status() != StatusCode::OK {
        return Err(ApiError::unavailable("citation provider unavailable"));
    }
    let value = bounded_json(response, MAX_CROSSREF_BYTES).await?;
    let message = value
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(ApiError::internal)?;
    let title = message
        .get("title")
        .and_then(Value::as_array)
        .and_then(|titles| titles.first())
        .and_then(Value::as_str)
        .unwrap_or(&doi)
        .trim()
        .chars()
        .take(500)
        .collect::<String>();
    let authors = message
        .get("author")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|author| {
            let given = author.get("given").and_then(Value::as_str).unwrap_or("");
            let family = author.get("family").and_then(Value::as_str).unwrap_or("");
            let name = format!("{given} {family}")
                .trim()
                .chars()
                .take(200)
                .collect::<String>();
            (!name.is_empty()).then_some(name)
        })
        .collect::<Vec<_>>();
    let publisher = message
        .get("publisher")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(300)
        .collect::<String>();
    let published = message
        .get("issued")
        .and_then(|issued| issued.get("date-parts"))
        .and_then(Value::as_array)
        .and_then(|parts| parts.first())
        .and_then(Value::as_array)
        .and_then(|parts| parts.first())
        .and_then(Value::as_u64)
        .map(|year| year.to_string());
    let author_text = if authors.is_empty() {
        "Unknown author".to_owned()
    } else {
        authors.join(", ")
    };
    let citation = format!(
        "{author_text}. “{title}.” {}{} https://doi.org/{doi}.",
        publisher,
        published
            .as_deref()
            .map(|year| format!(", {year}."))
            .unwrap_or_default(),
    )
    .replace("  ", " ");
    Ok(Json(json!({
        "citation": {
            "doi": doi,
            "title": title,
            "authors": authors,
            "publisher": publisher,
            "published": published,
            "url": format!("https://doi.org/{doi}"),
            "citation": citation,
        }
    }))
    .into_response())
}

async fn bounded_json(response: reqwest::Response, limit: usize) -> ApiResult<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ApiError::unavailable(
            "citation provider response is too large",
        ));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::unavailable("citation provider unavailable"))?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ApiError::unavailable(
                "citation provider response is too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| ApiError::unavailable("citation provider response is invalid"))
}

fn normalize_doi(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    for prefix in ["https://doi.org/", "http://doi.org/", "doi:"] {
        if value.to_ascii_lowercase().starts_with(prefix) {
            value = &value[prefix.len()..];
            break;
        }
    }
    value = value.trim().trim_end_matches(['.', ',', ';']);
    let (registrant, suffix) = value.split_once('/')?;
    if value.len() > 300
        || !registrant.starts_with("10.")
        || registrant.len() < 7
        || !registrant[3..].bytes().all(|byte| byte.is_ascii_digit())
        || suffix.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return None;
    }
    Some(value.to_owned())
}

async fn check_url(raw: String) -> Value {
    let checked_at = now_ms();
    let result = follow_url(&raw).await;
    match result {
        Ok((status, final_url, redirected)) => {
            let state = if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
                "missing"
            } else if status.is_success() || status.is_redirection() {
                if redirected {
                    "redirected"
                } else {
                    "reachable"
                }
            } else {
                "unavailable"
            };
            json!({
                "url": raw,
                "status": state,
                "httpStatus": status.as_u16(),
                "finalUrl": final_url,
                "checkedAtMs": checked_at,
            })
        }
        Err(CheckError::Blocked) => {
            json!({ "url": raw, "status": "blocked", "httpStatus": null, "finalUrl": null, "checkedAtMs": checked_at })
        }
        Err(CheckError::Unavailable) => {
            json!({ "url": raw, "status": "unavailable", "httpStatus": null, "finalUrl": null, "checkedAtMs": checked_at })
        }
    }
}

pub(crate) enum CheckError {
    Blocked,
    Unavailable,
}

async fn follow_url(raw: &str) -> Result<(StatusCode, String, bool), CheckError> {
    let mut url = parse_public_url(raw)?;
    let mut redirected = false;
    for hop in 0..=MAX_REDIRECTS {
        let response = pinned_request(&url, true).await?;
        let response = if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            pinned_request(&url, false).await?
        } else {
            response
        };
        if !response.status().is_redirection() {
            return Ok((response.status(), url.to_string(), redirected));
        }
        if hop == MAX_REDIRECTS {
            return Ok((response.status(), url.to_string(), true));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(CheckError::Unavailable)?;
        url = parse_public_url(
            url.join(location)
                .map_err(|_| CheckError::Blocked)?
                .as_str(),
        )?;
        redirected = true;
    }
    Err(CheckError::Unavailable)
}

pub(crate) fn parse_public_url(raw: &str) -> Result<Url, CheckError> {
    if raw.len() > MAX_URL_BYTES {
        return Err(CheckError::Blocked);
    }
    let mut url = Url::parse(raw).map_err(|_| CheckError::Blocked)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(CheckError::Blocked);
    }
    url.set_fragment(None);
    Ok(url)
}

async fn pinned_request(url: &Url, head: bool) -> Result<reqwest::Response, CheckError> {
    let client = pinned_client(url).await?;
    let request = if head {
        client.head(url.clone())
    } else {
        client
            .get(url.clone())
            .header(reqwest::header::RANGE, "bytes=0-0")
    };
    request
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml;q=0.8,*/*;q=0.1",
        )
        .header(reqwest::header::USER_AGENT, "Marks-Link-Inspector/0.1")
        .send()
        .await
        .map_err(|_| CheckError::Unavailable)
}

/// Resolve a URL to a public address and return a client pinned to that exact
/// resolution. Callers must repeat this for every redirect hop.
async fn pinned_client(url: &Url) -> Result<Client, CheckError> {
    let host = url.host_str().ok_or(CheckError::Blocked)?;
    let port = url.port_or_known_default().ok_or(CheckError::Blocked)?;
    let literal_ip = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
        .parse::<IpAddr>()
        .ok();
    let address = match literal_ip {
        Some(address) if public_ip(address) => SocketAddr::new(address, port),
        Some(_) => return Err(CheckError::Blocked),
        None => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| CheckError::Unavailable)?
            .find(|address| public_ip(address.ip()))
            .ok_or(CheckError::Blocked)?,
    };
    let mut client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8));
    if literal_ip.is_none() {
        client = client.resolve(host, address);
    }
    client.build().map_err(|_| CheckError::Unavailable)
}

pub(crate) async fn pinned_public_get(url: &Url) -> Result<reqwest::Response, CheckError> {
    pinned_client(url)
        .await?
        .get(url.clone())
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,text/plain;q=0.8",
        )
        .header(reqwest::header::USER_AGENT, "Marks-Importer/0.1")
        .send()
        .await
        .map_err(|_| CheckError::Unavailable)
}

fn public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_ipv4(address),
        IpAddr::V6(address) => public_ipv6(address),
    }
}

fn public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_unspecified()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4() {
        return public_ipv4(mapped);
    }
    let segments = address.segments();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        // Unique-local and link-local.
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        // Discard-only, NAT64, Teredo, ORCHID, documentation, and 6to4 can
        // encode or relay a non-public IPv4 destination. Link health does not
        // require them, so this intentionally fails closed.
        || (segments[0] == 0x0100 && segments[1] == 0)
        || (segments[0] == 0x0064 && segments[1] == 0xff9b)
        || (segments[0] == 0x2001 && segments[1] == 0)
        || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_documentation_networks_are_not_public() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.1.1",
            "169.254.1.1",
            "192.0.2.1",
            "198.51.100.4",
            "203.0.113.9",
            "::1",
            "fd00::1",
            "fe80::1",
            "64:ff9b::7f00:1",
            "2001::1",
            "2001:10::1",
            "2001:db8::1",
            "2002:7f00:1::",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn doi_normalization_is_narrow() {
        assert_eq!(
            normalize_doi("https://doi.org/10.1000/example."),
            Some("10.1000/example".into())
        );
        assert_eq!(normalize_doi("http://127.0.0.1/no"), None);
        assert_eq!(normalize_doi("10.x/no"), None);
    }
}
