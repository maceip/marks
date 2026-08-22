pub mod auth;
pub mod documents;

use crate::app::App;
use crate::error::ApiResult;
use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::Arc;

/// Liveness plus database writeability: a responding process whose database
/// cannot commit is not healthy.
pub async fn health(State(app): State<Arc<App>>) -> ApiResult<Response> {
    app.db.tx(|conn| {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS health_probe (probe INTEGER)")?;
        conn.execute("INSERT INTO health_probe (probe) VALUES (1)", [])?;
        conn.execute("DELETE FROM health_probe", [])?;
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })).into_response())
}
