use crate::app::App;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

const CSP: &str = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; font-src 'self' data:; connect-src 'self' wss:; worker-src 'self' blob:; manifest-src 'self'";

fn insert_if_absent(headers: &mut HeaderMap, name: HeaderName, value: &'static str) {
    if !headers.contains_key(&name) {
        headers.insert(name, HeaderValue::from_static(value));
    }
}

/// Security and cache policy belongs to the production process as well as the
/// reverse proxy. This keeps a direct bind, a replacement ingress, and CI from
/// silently serving a weaker application than production.
pub async fn harden(State(app): State<Arc<App>>, request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    insert_if_absent(headers, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    insert_if_absent(headers, header::REFERRER_POLICY, "no-referrer");
    insert_if_absent(
        headers,
        HeaderName::from_static("content-security-policy"),
        CSP,
    );
    insert_if_absent(
        headers,
        HeaderName::from_static("permissions-policy"),
        "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
    );
    insert_if_absent(
        headers,
        HeaderName::from_static("cross-origin-opener-policy"),
        "same-origin",
    );
    insert_if_absent(
        headers,
        HeaderName::from_static("cross-origin-resource-policy"),
        "same-origin",
    );
    insert_if_absent(headers, HeaderName::from_static("x-frame-options"), "DENY");
    insert_if_absent(
        headers,
        HeaderName::from_static("strict-transport-security"),
        "max-age=31536000",
    );
    headers.insert(
        HeaderName::from_static("x-marks-release"),
        HeaderValue::from_static(app.artifact.build_revision),
    );
    headers.insert(
        HeaderName::from_static("x-marks-engine"),
        HeaderValue::from_static(app.artifact.server_engine_revision),
    );

    if path.starts_with("/v1/")
        || path.starts_with("/collab/")
        || matches!(path.as_str(), "/healthz" | "/readyz")
    {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else if path.starts_with("/assets/") {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else if !path.starts_with("/a/") {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, must-revalidate"),
        );
    }
    response
}
