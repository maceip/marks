//! End-to-end invariants for the lossy presence side-channel. These tests use
//! real tickets, WebSockets, and the browser's ordered binary codec; presence
//! must never enter the durable ESBT/SQLite path.

mod common;

use common::peer::{
    MSG_EPHEMERAL, Peer, PeerEvent, PresenceEntry, Ticket, decode_presence, encode_presence,
};
use common::{TestServer, create_principal, temp_db};
use serde_json::{Value, json};
use std::time::Duration;

fn doc(site: u128) -> esbt::Document {
    esbt::Document::with_defaults(site).unwrap()
}
fn state(key: &str, value: Value) -> PresenceEntry {
    PresenceEntry {
        key: key.into(),
        age_ms: 0,
        value: Some(value),
    }
}
fn presence_key(site: u128, suffix: &str) -> String {
    format!("{site}-cm-{suffix}")
}
async fn json_of(response: reqwest::Response) -> Value {
    let status = response.status();
    let body = response.text().await.unwrap();
    serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("{status} was not JSON: {error}: {body:?}"))
}

async fn scratch(base: &str, http: &reqwest::Client) -> (String, String) {
    let response = http
        .post(format!("{base}/v1/auth/scratch"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201, "scratch creation");
    let auth = json_of(response).await;
    let header = format!(
        "MarksScratch {}.{}",
        auth["scratchId"].as_str().unwrap(),
        auth["capability"].as_str().unwrap()
    );
    let response = http
        .post(format!("{base}/v1/documents"))
        .header("Authorization", &header)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201, "scratch document");
    let made = json_of(response).await;
    (header, made["document"]["id"].as_str().unwrap().into())
}
async fn ticket(
    base: &str,
    http: &reqwest::Client,
    auth: &str,
    id: &str,
    site: Option<u128>,
) -> Ticket {
    Ticket::from_json(
        &json_of(
            http.post(format!("{base}/v1/scratch/documents/{id}/session"))
                .header("Authorization", auth)
                .json(&json!({"siteId": site.map(|x| x.to_string())}))
                .send()
                .await
                .unwrap(),
        )
        .await,
    )
}
async fn presence(peer: &mut Peer) -> Vec<PresenceEntry> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match peer.next_event().await {
                PeerEvent::Presence(value) => return value,
                PeerEvent::Closed(code) => panic!("closed: {code:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("presence message timeout")
}

#[tokio::test(flavor = "multi_thread")]
async fn scratch_guests_join_bootstrap_reorder_and_disconnect_cleanup() {
    let server = TestServer::spawn(temp_db("presence-scratch")).await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let (auth, id) = scratch(&server.base, &http).await;
    let ta = ticket(&server.base, &http, &auth, &id, None).await;
    let tb = ticket(&server.base, &http, &auth, &id, None).await;
    let mut a = Peer::connect(&server.base, &ta, doc(ta.site), None).await;
    let mut b = Peer::connect(&server.base, &tb, doc(tb.site), None).await;

    // A join bootstrap is an ordinary full-state frame; reordered selection
    // and identity frames remain independently decodable.
    let selection_key = presence_key(ta.site, "sel");
    let user_key = presence_key(ta.site, "user");
    a.send_presence(&[state(&selection_key, json!({"from": 8, "to": 12}))])
        .await;
    a.send_presence(&[state(&user_key, json!({"name": "untrusted"}))])
        .await;
    assert_eq!(presence(&mut b).await[0].key, selection_key);
    let identity = presence(&mut b).await;
    assert_eq!(identity[0].key, user_key);
    assert_ne!(identity[0].value.as_ref().unwrap()["name"], "untrusted");

    // Disconnect cleanup is explicit and lossy: a tombstone removes both
    // visual artifacts before transport close (expiry remains the fallback).
    a.send_presence(&[
        PresenceEntry {
            key: selection_key,
            age_ms: 0,
            value: None,
        },
        PresenceEntry {
            key: user_key,
            age_ms: 0,
            value: None,
        },
    ])
    .await;
    assert!(
        presence(&mut b)
            .await
            .iter()
            .all(|entry| entry.value.is_none())
    );
    drop(a);
    drop(b);
    drop(http);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnect_multiple_tabs_and_room_isolation() {
    let server = TestServer::spawn(temp_db("presence-isolation")).await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let (auth, first) = scratch(&server.base, &http).await;
    let second = json_of(
        http.post(format!("{}/v1/documents", server.base))
            .header("Authorization", &auth)
            .header("Origin", &server.base)
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
    )
    .await["document"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ta = ticket(&server.base, &http, &auth, &first, None).await;
    let tb = ticket(&server.base, &http, &auth, &first, None).await;
    let tc = ticket(&server.base, &http, &auth, &second, None).await;
    let mut a = Peer::connect(&server.base, &ta, doc(ta.site), None).await;
    let mut tab = Peer::connect(&server.base, &tb, doc(tb.site), None).await;
    let mut isolated = Peer::connect(&server.base, &tc, doc(tc.site), None).await;
    let user_key = presence_key(ta.site, "user");
    a.send_presence(&[state(&user_key, json!({"name":"untrusted"}))])
        .await;
    assert_eq!(presence(&mut tab).await[0].key, user_key);
    assert!(
        tokio::time::timeout(Duration::from_millis(150), isolated.next_event())
            .await
            .is_err()
    );

    let stable_site = ta.site;
    let replica = a.disconnect().await;
    let tr = ticket(&server.base, &http, &auth, &first, Some(stable_site)).await;
    let mut reconnected = Peer::connect(&server.base, &tr, replica, None).await;
    let selection_key = presence_key(stable_site, "sel");
    reconnected
        .send_presence(&[state(&selection_key, json!({"active":false}))])
        .await;
    let retired = presence(&mut tab).await;
    assert!(
        retired
            .iter()
            .any(|entry| entry.key == user_key && entry.value.is_none())
    );
    let replacement = presence(&mut tab).await;
    assert_eq!(replacement[0].key, selection_key,);
    assert_eq!(replacement[0].value.as_ref().unwrap()["active"], false);
    drop(reconnected);
    drop(tab);
    drop(isolated);
    drop(http);
    server.stop().await;
}

#[test]
fn rust_decodes_shared_frames_and_malformed_frames_fail_atomically() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/presence-store-v2.json")).unwrap();
    for case in fixture["valid"].as_array().unwrap() {
        let bytes: Vec<u8> = serde_json::from_value(case["bytes"].clone()).unwrap();
        let decoded = decode_presence(&bytes).unwrap();
        assert_eq!(
            encode_presence(&decoded).unwrap(),
            bytes,
            "{}",
            case["name"]
        );
    }
    for case in fixture["malformed"].as_array().unwrap() {
        let bytes: Vec<u8> = serde_json::from_value(case["bytes"].clone()).unwrap();
        assert!(decode_presence(&bytes).is_err(), "{}", case["name"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_and_oversized_frames_are_bounded_without_durable_writes() {
    let server = TestServer::spawn(temp_db("presence-malformed")).await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let (auth, id) = scratch(&server.base, &http).await;
    let ta = ticket(&server.base, &http, &auth, &id, None).await;
    let tb = ticket(&server.base, &http, &auth, &id, None).await;
    let mut a = Peer::connect(&server.base, &ta, doc(ta.site), None).await;
    let mut b = Peer::connect(&server.base, &tb, doc(tb.site), None).await;
    // The server's tighter network admission bound drops oversized presence
    // before decoding; document traffic and the room remain healthy.
    a.send(MSG_EPHEMERAL, &vec![0; 1537]).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(150), b.next_event())
            .await
            .is_err()
    );
    server
        .app
        .db
        .read(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_updates WHERE document_id=?1",
                [&id],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
    drop(a);
    drop(b);
    drop(http);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_traffic_does_not_consume_durable_rate_limit_or_persist() {
    let server = TestServer::spawn_with(temp_db("presence-rate"), |config| {
        config.max_mutations_per_second = 1
    })
    .await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let (auth, id) = scratch(&server.base, &http).await;
    let ta = ticket(&server.base, &http, &auth, &id, None).await;
    let tb = ticket(&server.base, &http, &auth, &id, None).await;
    let mut a = Peer::connect(&server.base, &ta, doc(ta.site), None).await;
    let mut b = Peer::connect(&server.base, &tb, doc(tb.site), None).await;
    let cursor_key = presence_key(ta.site, "cursor");
    let frame = [state(&cursor_key, json!({"from":1}))];
    for _ in 0..100 {
        a.send_presence(&frame).await;
    }
    assert_eq!(presence(&mut b).await[0].key, cursor_key);
    a.insert(0, "durable after saturation").await;
    b.converge_to("durable after saturation").await;
    let db_bytes = std::fs::read(&server.db_path).unwrap();
    assert!(!String::from_utf8_lossy(&db_bytes).contains(&cursor_key));
    let exported = http
        .get(format!("{}/v1/documents/{id}/export", server.base))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "durable after saturation");
    drop(a);
    drop(b);
    drop(http);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn authenticated_viewers_publish_presence_until_live_revocation() {
    let server = TestServer::spawn(temp_db("presence-viewer-revoke")).await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let owner = create_principal(&server.base, &http, "presence_owner").await;
    let viewer = create_principal(&server.base, &http, "presence_viewer").await;
    let made = json_of(
        http.post(format!("{}/v1/documents", server.base))
            .header("Cookie", &owner.cookie)
            .header("Origin", &server.base)
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let id = made["document"]["id"].as_str().unwrap();
    let grant = http
        .put(format!(
            "{}/v1/documents/{id}/shares/{}",
            server.base, viewer.principal_id
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &server.base)
        .json(&json!({"role":"viewer"}))
        .send()
        .await
        .unwrap();
    assert_eq!(grant.status(), 200);
    let owner_ticket = Ticket::from_json(
        &json_of(
            http.post(format!("{}/v1/documents/{id}/session", server.base))
                .header("Cookie", &owner.cookie)
                .header("Origin", &server.base)
                .json(&json!({}))
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    let viewer_ticket = Ticket::from_json(
        &json_of(
            http.post(format!("{}/v1/documents/{id}/session", server.base))
                .header("Cookie", &viewer.cookie)
                .header("Origin", &server.base)
                .json(&json!({}))
                .send()
                .await
                .unwrap(),
        )
        .await,
    );
    let mut a = Peer::connect(
        &server.base,
        &owner_ticket,
        doc(owner_ticket.site),
        Some(&owner.cookie),
    )
    .await;
    let mut v = Peer::connect(
        &server.base,
        &viewer_ticket,
        doc(viewer_ticket.site),
        Some(&viewer.cookie),
    )
    .await;
    let viewer_key = presence_key(viewer_ticket.site, "user");
    v.send_presence(&[state(&viewer_key, json!({"name":"untrusted"}))])
        .await;
    assert_eq!(presence(&mut a).await[0].key, viewer_key);
    let revoked = http
        .delete(format!(
            "{}/v1/documents/{id}/shares/{}",
            server.base, viewer.principal_id
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &server.base)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 200);
    assert_eq!(v.expect_close().await, Some(4401));
    drop(a);
    drop(v);
    drop(http);
    server.stop().await;
}
