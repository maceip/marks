//! WebSocket admission: one-use ticket in `Sec-WebSocket-Protocol`, consumed
//! atomically during upgrade, binding one immutable `RoomActor` per socket.
//! A guessed URL is not authority; there is no identity-free fallback.

use super::{CLOSE_CAPACITY, CLOSE_UNAUTHORIZED, JoinRefusal, OutMsg, RoomMsg};
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
    DocumentId, ESBT_SUBPROTOCOL, RoomActor, RoomIdentity, TICKET_SUBPROTOCOL_PREFIX,
    parse_ticket_subprotocol, redeem_document_ticket, redeem_scratch_document_ticket,
};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
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
                .max_frame_size(app.config.max_frame_bytes)
                .max_message_size(app.config.max_frame_bytes)
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
                let identity = principal_identity(actor.principal_id.as_str());
                RoomActor::Principal(marks_auth::Actor { identity, ..actor })
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
                let identity = scratch_identity(document_id.as_str(), actor.scratch_id.as_str());
                RoomActor::Scratch(marks_auth::ScratchActor { identity, ..actor })
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

pub(crate) fn principal_identity(principal_id: &str) -> RoomIdentity {
    let digest = Sha256::digest(principal_id.as_bytes());
    RoomIdentity {
        participant_id: principal_id.to_owned(),
        display_name: normalize_display_name(&format!("Member {:02X}{:02X}", digest[0], digest[1])),
        avatar: None,
        preferred_color: digest[2] % 8 + 1,
    }
}

fn normalize_display_name(input: &str) -> String {
    let mut out = String::new();
    for scalar in input.trim().chars().filter(|ch| !ch.is_control() && !matches!(*ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).take(64) {
        if out.len() + scalar.len_utf8() > 128 { break; }
        out.push(scalar);
    }
    if out.trim().is_empty() {
        "Anonymous".to_owned()
    } else {
        out
    }
}

pub(crate) fn scratch_identity(room_id: &str, scratch_id: &str) -> RoomIdentity {
    const ANIMALS: [&str; 8] = [
        "Otter", "Heron", "Fox", "Ibex", "Marten", "Falcon", "Lynx", "Tapir",
    ];
    let digest = Sha256::digest(format!("{room_id}\0{scratch_id}").as_bytes());
    RoomIdentity {
        // A one-way room-scoped pseudonym: neither scratch nor device id is exposed.
        participant_id: format!("guest-{}", Base64UrlUnpadded::encode_string(&digest[..8])),
        display_name: normalize_display_name(&format!(
            "Anonymous {}",
            ANIMALS[digest[8] as usize % ANIMALS.len()]
        )),
        avatar: None,
        preferred_color: digest[9] % 8 + 1,
    }
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
                JoinRefusal::Capacity => CLOSE_CAPACITY,
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
    let ping_ms = app.config.websocket_ping_ms;
    let idle_ms = app.config.websocket_idle_ms;
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_millis(ping_ms));
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Interval's first tick is immediate; wait for one full period before
        // adding transport traffic.
        ping.tick().await;
        loop {
            let outbound = tokio::select! {
                message = out_rx.recv() => match message {
                    Some(OutMsg::Frame(bytes)) => Message::Binary(bytes.into()),
                    Some(OutMsg::Close(code)) => Message::Close(Some(CloseFrame {
                        code,
                        reason: "".into(),
                    })),
                    None => break,
                },
                _ = ping.tick() => Message::Ping(Vec::new().into()),
            };
            let closing = matches!(outbound, Message::Close(_));
            match tokio::time::timeout(Duration::from_millis(idle_ms), sink.send(outbound)).await {
                Ok(Ok(())) if !closing => {}
                _ => break,
            }
        }
    });

    // Inbound: binary frames go to the room; everything else is transport.
    loop {
        let message =
            match tokio::time::timeout(Duration::from_millis(idle_ms), stream.next()).await {
                Ok(Some(message)) => message,
                Ok(None) | Err(_) => break,
            };
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
            // Browser and native clients answer server ping automatically.
            // Receiving pong (or any other transport frame) resets the idle
            // timeout because the next read starts a fresh deadline.
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

#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn malicious_names_are_bounded_and_direction_controls_are_removed() {
        let name = normalize_display_name(&format!("A\u{202e}<script>\n{}", "🦀".repeat(100)));
        assert!(!name.contains('\u{202e}'));
        assert!(!name.contains('\n'));
        assert!(name.chars().count() <= 64);
        assert!(name.len() <= 128);
    }

    #[test]
    fn scratch_identity_is_room_scoped_and_does_not_reveal_authority() {
        let first = scratch_identity("room-a", "raw-device-secret");
        let second = scratch_identity("room-b", "raw-device-secret");
        assert_ne!(first.participant_id, second.participant_id);
        assert!(!first.participant_id.contains("raw-device-secret"));
        assert!(first.display_name.starts_with("Anonymous "));
    }
}
