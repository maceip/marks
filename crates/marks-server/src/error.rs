use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Uniform external error shape. Internal detail goes to tracing, never to
/// the client: unauthenticated failures must not reveal which record failed.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: &'static str,
}

impl ApiError {
    pub const fn new(status: StatusCode, message: &'static str) -> Self {
        Self { status, message }
    }

    /// One indistinguishable answer for every authentication failure.
    pub fn unauthenticated() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "authentication failed")
    }

    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "not authorized")
    }

    /// Unknown, deleted, and unauthorized documents are the same answer.
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not found")
    }

    pub fn conflict() -> Self {
        Self::new(StatusCode::CONFLICT, "conflict")
    }

    pub fn bad_request(message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn rate_limited() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "rate limited")
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        tracing::error!(target: "marks_server::db", %error, "database failure");
        Self::internal()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
