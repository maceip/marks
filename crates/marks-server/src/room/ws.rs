//! WebSocket admission: one-use ticket in `Sec-WebSocket-Protocol`, consumed
//! atomically during upgrade, binding one immutable `RoomActor` per socket.
//! A guessed URL is not authority; there is no identity-free fallback.

use super::{CLOSE_UNAUTHORIZED, JoinRefusal, OutMsg, RoomMsg};
use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::guard;
use crate::ids::now_ms;
use crate::store;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use base64ct::{Base64UrlUnpadded, Encoding};
use futures_util::{SinkExt, StreamExt};
use marks_auth::{
    DocumentId, ESBT_SUBPROTOCOL, RoomActor, TICKET_SUBPROTOCOL_PREFIX, parse_ticket_subprotocol,
    redeem_document_ticket, redeem_scratch_document_ticket,
};
use rusqlite::params;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

pub async fn collab_esbt(
    State(app): State<Arc<App>>,
    Path(document_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    match admit(&app, &document_id, &query, &headers) {
        Ok((actor, client_version)) => {
            let rooms_document_id = match DocumentId::new(document_id) {
                Ok(id) => id,
                Err(_) => return ApiError::not_found().into_response(),
            };
            upgrade
                .protocols([ESBT_SUBPROTOCOL])
                .on_upgrade(move |socket| {
                    socket_loop(app, rooms_document_id, actor, client_version, socket)
                })
        }
        Err(error) => error.into_response(),
    }
}

fn admit(
    app: &App,
    document_id: &str,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
) -> ApiResult<(RoomActor, Option<esbt::clock::Version>)> {
    guard::reject_foreign_origin(app, headers)?;
    let document_id = DocumentId::new(document_id).map_err(|_| ApiError::not_found())?;

    // The bearer ticket travels only in the subprotocol offer; it is parsed
    // here and never logged or echoed.
    let offered = offered_protocols(headers);
    if !offered.iter().any(|value| value == ESBT_SUBPROTOCOL) {
        return Err(ApiError::bad_request("missing esbt subprotocol"));
    }
    let ticket_offer = offered
        .iter()
        .find(|value| value.starts_with(TICKET_SUBPROTOCOL_PREFIX))
        .ok_or_else(ApiError::unauthenticated)?;
    let (ticket_id, ticket_secret) =
        parse_ticket_subprotocol(ticket_offer).map_err(|_| ApiError::unauthenticated())?;

    // Reconnect state offered by the client. Credentials may not ride the
    // URL; an unreadable version vector only downgrades to a snapshot.
    let client_version = query.get("vv").and_then(|value| {
        let bytes = Base64UrlUnpadded::decode_vec(value).ok()?;
        esbt::clock::Version::decode_with_limits(&bytes, &app.limits).ok()
    });

    // For principal tickets the session cookie is validated again during
    // upgrade, exactly as at mint time.
    let cookie = guard::cookie_session(app, headers).ok();
    let now = now_ms();

    let actor = app.db.tx(|conn| {
        let ticket = store::load_ticket(conn, &ticket_id)?.ok_or_else(ApiError::unauthenticated)?;
        let document = store::load_document(conn, &document_id)?.ok_or_else(ApiError::not_found)?;
        if document.record.deleted_at_ms.is_some() {
            return Err(ApiError::not_found());
        }
        let actor = match &ticket {
            store::StoredTicket::Principal(stored) => {
                let cookie = cookie.as_ref().ok_or_else(ApiError::unauthenticated)?;
                let actor = redeem_document_ticket(
                    &stored.record,
                    &ticket_secret,
                    &cookie.session,
                    &document.record,
                    &stored.record.esbt_site,
                    now,
                )
                .map_err(|_| ApiError::unauthenticated())?;
                RoomActor::Principal(actor)
            }
            store::StoredTicket::Scratch(stored) => {
                let scratch = store::load_scratch(conn, &stored.record.scratch_id)?
                    .ok_or_else(ApiError::unauthenticated)?;
                let actor = redeem_scratch_document_ticket(
                    &stored.record,
                    &ticket_secret,
                    &scratch,
                    &document.record,
                    &stored.record.esbt_site,
                    now,
                )
                .map_err(|_| ApiError::unauthenticated())?;
                RoomActor::Scratch(actor)
            }
        };
        // Consume atomically: a validation that raced another upgrade loses
        // here, inside the same transaction.
        let consumed = conn.execute(
            "UPDATE document_tickets SET consumed_at = ?2
             WHERE id = ?1 AND consumed_at IS NULL AND revoked_at IS NULL",
            params![ticket_id.as_str(), store::ms(now)],
        )?;
        if consumed != 1 {
            return Err(ApiError::unauthenticated());
        }
        Ok(actor)
    })?;

    Ok((actor, client_version))
}

fn offered_protocols(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

async fn socket_loop(
    app: Arc<App>,
    document_id: DocumentId,
    actor: RoomActor,
    client_version: Option<esbt::clock::Version>,
    socket: WebSocket,
) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<OutMsg>(256);

    let joined = match app
        .rooms
        .join(&document_id, actor, client_version, out_tx)
        .await
    {
        Ok(joined) => joined,
        Err(refusal) => {
            let code = match refusal {
                JoinRefusal::Gone => super::CLOSE_DOCUMENT_DELETED,
                JoinRefusal::Stale => CLOSE_UNAUTHORIZED,
                JoinRefusal::Internal => super::CLOSE_INTERNAL,
            };
            let _ = sink
                .send(Message::Close(Some(CloseFrame {
                    code,
                    reason: "".into(),
                })))
                .await;
            return;
        }
    };

    // Outbound: room frames and the room-chosen close code.
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            match message {
                OutMsg::Frame(bytes) => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                OutMsg::Close(code) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: "".into(),
                        })))
                        .await;
                    break;
                }
            }
        }
    });

    // Inbound: binary frames go to the room; everything else is transport.
    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Binary(data)) => {
                if joined
                    .tx
                    .send(RoomMsg::Frame {
                        conn: joined.conn,
                        data: data.to_vec(),
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    // Leaving drops the room's sender; the writer drains and exits, so any
    // in-flight close frame still reaches the peer.
    let _ = joined.tx.send(RoomMsg::Leave { conn: joined.conn }).await;
    let _ = writer.await;
}

/// The retired Loro/Yjs room paths must be refused at the socket, not left to
/// a 404 fallback that a static file server might shadow.
pub async fn collab_retired() -> Response {
    ApiError::not_found().into_response()
}
