pub mod agent;
pub mod assets;
pub mod auth;
pub mod documents;
pub mod review;

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::Arc;

/// Cheap process/database-read liveness. Durable database writeability is
/// proven by the process-owned heartbeat and exposed separately at `/readyz`.
pub async fn health(State(app): State<Arc<App>>) -> ApiResult<Response> {
    app.db.read(|connection| {
        connection.query_row("SELECT 1", [], |_| Ok(()))?;
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true, "service": "marks-server" })).into_response())
}

/// Traffic readiness requires a recent FULL-sync writer commit. Health-check
/// request volume therefore cannot manufacture write load or hide a wedged
/// writer behind successful reads.
pub async fn ready(State(app): State<Arc<App>>) -> ApiResult<Response> {
    if !app
        .health
        .database_ready(app.config.database_heartbeat_stale_ms)
    {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "database writer unavailable",
        ));
    }
    Ok(Json(json!({
        "ok": true,
        "databaseWriteAt": app.health.last_database_write_ms(),
    }))
    .into_response())
}

/// Public, non-secret identity for correlating the server binary, native ESBT
/// dependency, browser Wasm, ABI, and resource profile in one runtime receipt.
pub async fn artifact(State(app): State<Arc<App>>) -> Response {
    Json(app.artifact.clone()).into_response()
}
