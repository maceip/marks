//! A test collaborator: a real ESBT-web Rust replica speaking the Marks room
//! protocol over a real WebSocket — exactly what a future native/Wasm client
//! does.
//!
//! Shared across integration crates; some helpers are unused in a given crate.
#![allow(dead_code)]

use base64ct::{Base64UrlUnpadded, Encoding};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use marks_server::room::protocol::{MutationKind, decode_committed, encode_mutation};

const PRESENCE_TAG: u8 = 5;
const PRESENCE_DELETED: u8 = 1;
const MAX_PRESENCE_BYTES: usize = 64 * 1024;
const MAX_PRESENCE_ENTRIES: usize = 256;
const MAX_PRESENCE_KEY_BYTES: usize = 256;
const MAX_PRESENCE_VALUE_BYTES: usize = 16 * 1024;

pub const MSG_UPDATE: u8 = 0x01;
pub const MSG_EPHEMERAL: u8 = 0x02;
pub const MSG_SERVER_VV: u8 = 0x03;
pub const MSG_SNAPSHOT: u8 = 0x04;
pub const MSG_SYNCED: u8 = 0x05;
pub const MSG_MUTATION: u8 = 0x06;
pub const MSG_COMMITTED: u8 = 0x07;

static NEXT_MUTATION_ID: AtomicU64 = AtomicU64::new(1);

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
    Committed([u8; 16], u64),
    Closed(Option<u16>),
    Presence(Vec<PresenceEntry>),
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PresenceEntry {
    pub key: String,
    pub age_ms: u64,
    pub value: Option<serde_json::Value>,
}

/// Encode the exact transient v1 payload used by the browser PresenceStore.
pub fn encode_presence(entries: &[PresenceEntry]) -> Result<Vec<u8>, String> {
    if entries.len() > MAX_PRESENCE_ENTRIES {
        return Err("too many presence entries".into());
    }
    let mut out = vec![PRESENCE_TAG];
    write_uint(&mut out, entries.len() as u64);
    for entry in entries {
        write_bytes(&mut out, entry.key.as_bytes(), MAX_PRESENCE_KEY_BYTES)?;
        if entry.key.is_empty() {
            return Err("empty presence key".into());
        }
        match &entry.value {
            None => out.push(PRESENCE_DELETED),
            Some(value) => {
                out.push(0);
                write_uint(&mut out, entry.age_ms);
                let json = serde_json::to_vec(value).map_err(|error| error.to_string())?;
                write_bytes(&mut out, &json, MAX_PRESENCE_VALUE_BYTES)?;
            }
        }
        if out.len() > MAX_PRESENCE_BYTES {
            return Err("presence payload exceeds 64 KiB".into());
        }
    }
    Ok(out)
}

/// Decode atomically: no entry is returned unless the complete frame is valid.
pub fn decode_presence(bytes: &[u8]) -> Result<Vec<PresenceEntry>, String> {
    if bytes.is_empty() || bytes.len() > MAX_PRESENCE_BYTES {
        return Err("invalid presence payload length".into());
    }
    let mut reader = PresenceReader { bytes, offset: 0 };
    if reader.u8()? != PRESENCE_TAG {
        return Err("unsupported presence payload".into());
    }
    let count = reader.uint()?;
    if count > MAX_PRESENCE_ENTRIES as u64 {
        return Err("too many presence entries".into());
    }
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let key = String::from_utf8(reader.bytes(MAX_PRESENCE_KEY_BYTES)?.to_vec())
            .map_err(|_| "invalid presence key utf-8".to_owned())?;
        if key.is_empty() {
            return Err("empty presence key".into());
        }
        let flags = reader.u8()?;
        if flags == PRESENCE_DELETED {
            entries.push(PresenceEntry {
                key,
                age_ms: 0,
                value: None,
            });
        } else if flags == 0 {
            let age_ms = reader.uint()?;
            let value = serde_json::from_slice(reader.bytes(MAX_PRESENCE_VALUE_BYTES)?)
                .map_err(|_| "invalid presence json".to_owned())?;
            entries.push(PresenceEntry {
                key,
                age_ms,
                value: Some(value),
            });
        } else {
            return Err("unsupported presence flags".into());
        }
    }
    if reader.offset != bytes.len() {
        return Err("trailing presence bytes".into());
    }
    Ok(entries)
}

struct PresenceReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl PresenceReader<'_> {
    fn u8(&mut self) -> Result<u8, String> {
        let value = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or_else(|| "truncated presence payload".to_owned())?;
        self.offset += 1;
        Ok(value)
    }
    fn uint(&mut self) -> Result<u64, String> {
        let mut value = 0_u64;
        for index in 0..10 {
            let byte = self.u8()?;
            if index == 9 && byte > 1 {
                return Err("presence integer overflow".into());
            }
            value |= u64::from(byte & 0x7f) << (index * 7);
            if byte & 0x80 == 0 {
                if index > 0 && byte == 0 {
                    return Err("non-canonical presence integer".into());
                }
                return Ok(value);
            }
        }
        Err("presence integer overflow".into())
    }
    fn bytes(&mut self, maximum: usize) -> Result<&[u8], String> {
        let length = usize::try_from(self.uint()?)
            .map_err(|_| "invalid presence field length".to_owned())?;
        if length > maximum
            || self
                .offset
                .checked_add(length)
                .is_none_or(|end| end > self.bytes.len())
        {
            return Err("invalid presence field length".into());
        }
        let start = self.offset;
        self.offset += length;
        Ok(&self.bytes[start..self.offset])
    }
}

fn write_uint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        out.push(byte | if value > 0 { 0x80 } else { 0 });
        if value == 0 {
            break;
        }
    }
}
fn write_bytes(out: &mut Vec<u8>, bytes: &[u8], maximum: usize) -> Result<(), String> {
    if bytes.len() > maximum {
        return Err("presence field exceeds its limit".into());
    }
    write_uint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
    Ok(())
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
                "marks.esbt.v2, marks.ticket.v1.{}.{}",
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
            Some("marks.esbt.v2"),
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
                        if !version.covers(&self.doc.version())
                            && let Ok(missing) = self.doc.export_update(&version)
                        {
                            self.send_mutation(MutationKind::Update, &missing).await;
                        }
                        PeerEvent::Other
                    }
                    MSG_SYNCED => PeerEvent::Synced,
                    MSG_COMMITTED => {
                        let receipt = decode_committed(payload).expect("committed receipt");
                        PeerEvent::Committed(receipt.id, receipt.revision)
                    }
                    MSG_EPHEMERAL => PeerEvent::Presence(
                        decode_presence(payload).expect("decode production presence payload"),
                    ),
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

    pub async fn send_presence(&mut self, entries: &[PresenceEntry]) {
        let payload = encode_presence(entries).expect("encode production presence payload");
        self.send(MSG_EPHEMERAL, &payload).await;
    }

    pub async fn send_mutation(&mut self, kind: MutationKind, payload: &[u8]) -> [u8; 16] {
        let id = next_mutation_id();
        self.send_mutation_with_id(id, kind, payload).await;
        id
    }

    pub async fn send_mutation_with_id(
        &mut self,
        id: [u8; 16],
        kind: MutationKind,
        payload: &[u8],
    ) {
        let encoded = encode_mutation(id, kind, payload).expect("encode mutation");
        self.send(MSG_MUTATION, &encoded).await;
    }

    pub async fn wait_committed(&mut self, expected_id: [u8; 16]) -> u64 {
        loop {
            match self.next_event().await {
                PeerEvent::Committed(id, revision) if id == expected_id => return revision,
                PeerEvent::Closed(code) => panic!("closed before commit: {code:?}"),
                _ => {}
            }
        }
    }

    /// Type locally and put the canonical update on the wire.
    pub async fn insert(&mut self, index: usize, text: &str) {
        let update = self
            .doc
            .insert(index, text, None)
            .expect("local insert")
            .expect("local update");
        let id = self
            .send_mutation(MutationKind::Update, &update.canonical_bytes)
            .await;
        self.wait_committed(id).await;
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

fn next_mutation_id() -> [u8; 16] {
    let sequence = NEXT_MUTATION_ID.fetch_add(1, Ordering::Relaxed);
    let mut id = [0_u8; 16];
    id[8..].copy_from_slice(&sequence.to_be_bytes());
    id
}
