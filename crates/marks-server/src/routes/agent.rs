use crate::agent::protocol::{CreateRunBody, ToolResultBody};
use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::routes::documents::load_live_document;
use crate::store;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::stream;
use marks_auth::{DocumentAction, DocumentId, authorize_document_action, resolve_document_role};
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventQuery {
    pub after: Option<u64>,
}

pub async fn capabilities(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    guard::cookie_session(&app, &headers)?;
    Ok(Json(app.agents.capabilities()).into_response())
}

pub async fn create_run(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<CreateRunBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    guard::require_csrf(&headers, &cookie.secret)?;
    let document_id =
        DocumentId::new(body.document_id.clone()).map_err(|_| ApiError::not_found())?;
    app.db.read(|connection| {
        let row = load_live_document(connection, &document_id)?;
        let acl = store::load_acl(connection, &document_id)?;
        let role = resolve_document_role(&row.record, cookie.session.principal_id(), &acl)
            .map_err(|_| ApiError::not_found())?;
        if !authorize_document_action(role, DocumentAction::Read) {
            return Err(ApiError::not_found());
        }
        Ok(())
    })?;
    let response = app
        .agents
        .start_run(
            cookie.session.id().as_str(),
            cookie.session.principal_id().as_str(),
            body,
        )
        .await?;
    let status = if response.replayed {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok((status, Json(response)).into_response())
}

pub async fn events(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    let header_after = headers
        .get("last-event-id")
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| ApiError::bad_request("invalid event cursor"))
        })
        .transpose()?;
    let after = query.after.unwrap_or(0).max(header_after.unwrap_or(0));
    let run = app
        .agents
        .load_owned_run(cookie.session.id().as_str(), &id)?;
    let event_stream = stream::unfold((run, after), |(run, cursor)| async move {
        let event = run.next_event(cursor).await?;
        let next = event.sequence;
        let data = serde_json::to_string(&event.data).unwrap_or_else(|_| "{}".to_owned());
        let event = Event::default()
            .id(next.to_string())
            .event(event.kind)
            .data(data);
        Some((Ok::<Event, Infallible>(event), (run, next)))
    });
    Ok(Sse::new(event_stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keepalive"),
        )
        .into_response())
}

pub async fn tool_result(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ToolResultBody>,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    guard::require_csrf(&headers, &cookie.secret)?;
    let response = app
        .agents
        .submit_tool_result(cookie.session.id().as_str(), &id, body)?;
    Ok(Json(response).into_response())
}

pub async fn cancel(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let cookie = guard::cookie_session(&app, &headers)?;
    guard::require_same_origin(&app, &headers)?;
    guard::require_csrf(&headers, &cookie.secret)?;
    let response = app.agents.cancel(cookie.session.id().as_str(), &id)?;
    Ok(Json(response).into_response())
}
