//! A test collaborator: a real ESBT-web Rust replica speaking the Marks room
//! protocol over a real WebSocket — exactly what a future native/Wasm client
//! does.
//!
//! Shared across integration crates; some helpers are unused in a given crate.
#![allow(dead_code)]

use base64ct::{Base64UrlUnpadded, Encoding};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const MSG_UPDATE: u8 = 0x01;
pub const MSG_EPHEMERAL: u8 = 0x02;
pub const MSG_SERVER_VV: u8 = 0x03;
pub const MSG_SNAPSHOT: u8 = 0x04;
pub const MSG_SYNCED: u8 = 0x05;

pub struct Peer {
    pub doc: esbt::Document,
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

pub struct Ticket {
    pub room_url: String,
    pub ticket_id: String,
    pub ticket_secret: String,
    pub site: u128,
}

impl Ticket {
    pub fn from_json(value: &serde_json::Value) -> Ticket {
        Ticket {
            room_url: value["roomUrl"].as_str().unwrap().to_owned(),
            ticket_id: value["ticketId"].as_str().unwrap().to_owned(),
            ticket_secret: value["ticketSecret"].as_str().unwrap().to_owned(),
            site: value["siteId"].as_str().unwrap().parse::<u128>().unwrap(),
        }
    }
}

pub enum PeerEvent {
    Synced,
    Applied,
    Closed(Option<u16>),
    Other,
}

impl Peer {
    /// Connect and complete the initial sync handshake (server VV, delta or
    /// snapshot, MSG_SYNCED), answering the server's version vector with this
    /// replica's missing operations — the browser engine's exact behavior.
    pub async fn connect(
        base: &str,
        ticket: &Ticket,
        doc: esbt::Document,
        cookie: Option<&str>,
    ) -> Peer {
        let ws_base = base.replace("http://", "ws://");
        let mut url = format!("{ws_base}{}", ticket.room_url);
        let vv = doc.version().encode();
        if !vv.is_empty() {
            url.push_str(&format!("?vv={}", Base64UrlUnpadded::encode_string(&vv)));
        }
        let mut request = url.into_client_request().expect("ws request");
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            format!(
                "marks.esbt.v1, marks.ticket.v1.{}.{}",
                ticket.ticket_id, ticket.ticket_secret
            )
            .parse()
            .unwrap(),
        );
        if let Some(cookie) = cookie {
            request
                .headers_mut()
                .insert("Cookie", cookie.parse().unwrap());
        }
        let (ws, response) = tokio_tungstenite::connect_async(request)
            .await
            .expect("ws connect");
        assert_eq!(
            response
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok()),
            Some("marks.esbt.v1"),
            "server selects only the esbt subprotocol"
        );
        let mut peer = Peer { doc, ws };
        peer.pump_until_synced().await;
        peer
    }

    async fn pump_until_synced(&mut self) {
        loop {
            match self.next_event().await {
                PeerEvent::Synced => return,
                PeerEvent::Closed(code) => panic!("closed before sync: {code:?}"),
                _ => {}
            }
        }
    }

    /// Process exactly one inbound message.
    pub async fn next_event(&mut self) -> PeerEvent {
        let message = tokio::time::timeout(std::time::Duration::from_secs(10), self.ws.next())
            .await
            .expect("room message timeout")
            .expect("socket stream ended")
            .expect("socket error");
        match message {
            Message::Binary(data) => {
                if data.is_empty() {
                    return PeerEvent::Other;
                }
                let (tag, payload) = (data[0], &data[1..]);
                match tag {
                    MSG_UPDATE => {
                        self.doc.apply_bytes(payload).expect("apply remote update");
                        PeerEvent::Applied
                    }
                    MSG_SNAPSHOT => {
                        self.doc
                            .apply_snapshot_bytes(payload)
                            .expect("apply snapshot");
                        PeerEvent::Applied
                    }
                    MSG_SERVER_VV => {
                        let version = esbt::clock::Version::decode(payload).expect("server vv");
                        // Reply only when this replica actually holds ops the
                        // server lacks. Read-only sockets never send updates;
                        // the room closes writers it has not authorized.
                        if !version.covers(&self.doc.version()) {
                            if let Ok(missing) = self.doc.export_update(&version) {
                                self.send(MSG_UPDATE, &missing).await;
                            }
                        }
                        PeerEvent::Other
                    }
                    MSG_SYNCED => PeerEvent::Synced,
                    MSG_EPHEMERAL => PeerEvent::Other,
                    _ => PeerEvent::Other,
                }
            }
            Message::Close(frame) => PeerEvent::Closed(frame.map(|frame| frame.code.into())),
            _ => PeerEvent::Other,
        }
    }

    pub async fn send(&mut self, tag: u8, payload: &[u8]) {
        let mut framed = Vec::with_capacity(payload.len() + 1);
        framed.push(tag);
        framed.extend_from_slice(payload);
        self.ws
            .send(Message::Binary(framed.into()))
            .await
            .expect("ws send");
    }

    /// Type locally and put the canonical update on the wire.
    pub async fn insert(&mut self, index: usize, text: &str) {
        let update = self
            .doc
            .insert(index, text, None)
            .expect("local insert")
            .expect("local update");
        self.send(MSG_UPDATE, &update.canonical_bytes).await;
    }

    /// Pump messages until this replica's text equals `expected`.
    pub async fn converge_to(&mut self, expected: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while self.doc.text() != expected {
            assert!(
                std::time::Instant::now() < deadline,
                "did not converge: have {:?}, want {expected:?}",
                self.doc.text()
            );
            let _ = self.next_event().await;
        }
    }

    /// Wait for the server to close this socket and return the close code.
    pub async fn expect_close(&mut self) -> Option<u16> {
        loop {
            if let PeerEvent::Closed(code) = self.next_event().await {
                return code;
            }
        }
    }

    pub async fn disconnect(mut self) -> esbt::Document {
        let _ = self.ws.close(None).await;
        self.doc
    }
}
