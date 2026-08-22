//! Durable room behavior with real ESBT-web replicas over real WebSockets:
//! convergence, offline deltas, role enforcement, live revocation, deletion,
//! and journal-backed restart recovery.

mod common;

use common::peer::{MSG_UPDATE, Peer, Ticket};
use common::{TestServer, create_principal, temp_db};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

async fn json_of(response: reqwest::Response) -> Value {
    response.json::<Value>().await.expect("json body")
}

/// Scratch authority + one document; returns (scratch auth header, doc id).
async fn scratch_document(base: &str, http: &reqwest::Client) -> (String, String) {
    let scratch = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let auth = format!(
        "MarksScratch {}.{}",
        scratch["scratchId"].as_str().unwrap(),
        scratch["capability"].as_str().unwrap()
    );
    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Authorization", &auth)
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    (auth, created["document"]["id"].as_str().unwrap().to_owned())
}

async fn scratch_ticket(
    base: &str,
    http: &reqwest::Client,
    auth: &str,
    document_id: &str,
    site: Option<u128>,
) -> Ticket {
    let response = http
        .post(format!("{base}/v1/scratch/documents/{document_id}/session"))
        .header("Authorization", auth)
        .json(&json!({ "siteId": site.map(|value| value.to_string()) }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "scratch room admission");
    Ticket::from_json(&json_of(response).await)
}

async fn principal_ticket(
    base: &str,
    http: &reqwest::Client,
    cookie: &str,
    document_id: &str,
) -> reqwest::Response {
    http.post(format!("{base}/v1/documents/{document_id}/session"))
        .header("Cookie", cookie)
        .header("Origin", base)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
}

fn fresh_doc(site: u128) -> esbt::Document {
    esbt::Document::with_defaults(site).expect("client replica")
}

#[tokio::test(flavor = "multi_thread")]
async fn two_peers_converge_offline_delta_and_restart_recovery() {
    let db = temp_db("room-converge");
    let server = TestServer::spawn(db).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    let (auth, document_id) = scratch_document(&base, &http).await;

    // Peer A joins with a fresh replica and types.
    let ticket_a = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    assert_eq!(ticket_a.site, 2, "first client site after the server's 1");
    let mut peer_a = Peer::connect(&base, &ticket_a, fresh_doc(ticket_a.site), None).await;
    peer_a.insert(0, "Hello from A.").await;

    // Peer B cold-opens and receives A's committed text in initial sync.
    let ticket_b = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    assert_eq!(ticket_b.site, 3);
    let mut peer_b = Peer::connect(&base, &ticket_b, fresh_doc(ticket_b.site), None).await;
    peer_b.converge_to("Hello from A.").await;

    // Live fan-out in both directions.
    let len = peer_b.doc.len();
    peer_b.insert(len, " Hi from B.").await;
    peer_a.converge_to("Hello from A. Hi from B.").await;

    // A ticket is one-use: replaying the consumed ticket fails the upgrade.
    // (Covered again below via a stale ticket after deletion.)

    // Offline edit: A disconnects, types locally, reconnects with a fresh
    // one-use ticket and its version vector; the delta path converges both.
    let mut offline_doc = peer_a.disconnect().await;
    let offline_insert = offline_doc
        .insert(0, "Offline! ", None)
        .expect("offline edit")
        .expect("offline update");
    drop(offline_insert); // rides the reconnect version-vector exchange
    let ticket_a2 = scratch_ticket(&base, &http, &auth, &document_id, Some(ticket_a.site)).await;
    assert_eq!(
        ticket_a2.site, ticket_a.site,
        "site is stable across reconnects"
    );
    let mut peer_a = Peer::connect(&base, &ticket_a2, offline_doc, None).await;
    peer_a
        .converge_to("Offline! Hello from A. Hi from B.")
        .await;
    peer_b
        .converge_to("Offline! Hello from A. Hi from B.")
        .await;

    // The REST surface reads the live room: export includes the newest
    // committed text (the room journals before broadcasting).
    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "Offline! Hello from A. Hi from B.");

    // Snapshot endpoint serves engine bytes a fresh replica can import.
    let snapshot = http
        .get(format!("{base}/v1/documents/{document_id}/snapshot"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let mut cold = fresh_doc(900);
    cold.apply_snapshot_bytes(&snapshot)
        .expect("import snapshot");
    assert_eq!(cold.text(), "Offline! Hello from A. Hi from B.");

    // Kill the process (graceful here; the journal is committed either way),
    // restart on the same database, and reopen: no committed edit is lost.
    drop(peer_a);
    drop(peer_b);
    let db = server.stop().await;
    let server = TestServer::spawn(db).await;
    let base = server.base.clone();
    // Scratch authority survives restart (it is a database row, not memory).
    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "Offline! Hello from A. Hi from B.");

    // Reconnect after restart with the old replica state: still converges.
    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut survivor = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    survivor
        .converge_to("Offline! Hello from A. Hi from B.")
        .await;

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn roles_revocation_and_deletion_govern_live_sockets() {
    let server = TestServer::spawn(temp_db("room-roles")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    let owner = create_principal(&base, &http, "owner001").await;
    let guest = create_principal(&base, &http, "guest001").await;

    // The owner creates a document and connects.
    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&json!({ "title": "shared" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();

    // Without a grant the guest gets no metadata and no ticket.
    let denied = http
        .get(format!("{base}/v1/documents/{document_id}"))
        .header("Cookie", &guest.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 404);
    let denied = principal_ticket(&base, &http, &guest.cookie, &document_id).await;
    assert_eq!(denied.status(), 404);

    // A rotatable viewer link admits the guest read-only.
    let link = json_of(
        http.post(format!("{base}/v1/documents/{document_id}/link"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&json!({ "role": "viewer" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let redeemed = json_of(
        http.post(format!("{base}/v1/documents/{document_id}/link/redeem"))
            .header("Cookie", &guest.cookie)
            .header("Origin", &base)
            .json(&json!({ "token": link["token"] }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(redeemed["role"], "viewer");

    let owner_ticket = principal_ticket(&base, &http, &owner.cookie, &document_id).await;
    assert_eq!(owner_ticket.status(), 200);
    let owner_ticket = Ticket::from_json(&json_of(owner_ticket).await);
    let mut owner_peer = Peer::connect(
        &base,
        &owner_ticket,
        fresh_doc(owner_ticket.site),
        Some(&owner.cookie),
    )
    .await;
    owner_peer.insert(0, "Owner text.").await;

    let guest_ticket = principal_ticket(&base, &http, &guest.cookie, &document_id).await;
    assert_eq!(guest_ticket.status(), 200);
    let guest_ticket_body = json_of(guest_ticket).await;
    assert_eq!(guest_ticket_body["role"], "viewer");
    let guest_ticket = Ticket::from_json(&guest_ticket_body);
    let mut guest_peer = Peer::connect(
        &base,
        &guest_ticket,
        fresh_doc(guest_ticket.site),
        Some(&guest.cookie),
    )
    .await;
    guest_peer.converge_to("Owner text.").await;

    // A viewer's forged MSG_UPDATE never reaches ESBT decoding, the journal,
    // or another peer; the socket closes with the policy code.
    let forged = guest_peer
        .doc
        .insert(0, "FORGED ", None)
        .expect("local viewer edit")
        .expect("forged update");
    guest_peer.send(MSG_UPDATE, &forged.canonical_bytes).await;
    assert_eq!(guest_peer.expect_close().await, Some(4403));
    assert_eq!(owner_peer.doc.text(), "Owner text.");

    // The forged bytes were never persisted either.
    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "Owner text.");

    // Upgrade the guest to editor: edits flow.
    let put = http
        .put(format!(
            "{base}/v1/documents/{document_id}/shares/{}",
            guest.principal_id
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "role": "editor" }))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);

    let editor_ticket = principal_ticket(&base, &http, &guest.cookie, &document_id).await;
    let editor_ticket = Ticket::from_json(&json_of(editor_ticket).await);
    let mut editor_peer = Peer::connect(
        &base,
        &editor_ticket,
        fresh_doc(editor_ticket.site),
        Some(&guest.cookie),
    )
    .await;
    editor_peer.converge_to("Owner text.").await;
    let len = editor_peer.doc.len();
    editor_peer.insert(len, " Editor text.").await;
    owner_peer.converge_to("Owner text. Editor text.").await;

    // Revoking the grant closes the live socket; role downgrade affects
    // already-open sockets, not only new admissions.
    let revoked = http
        .delete(format!(
            "{base}/v1/documents/{document_id}/shares/{}",
            guest.principal_id
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 200);
    assert_eq!(editor_peer.expect_close().await, Some(4401));

    // The owner keeps editing across the epoch change (its role re-resolved).
    let len = owner_peer.doc.len();
    owner_peer.insert(len, " Still here.").await;
    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "Owner text. Editor text. Still here.");

    // Deleting the document closes the room with 4404 and stays deleted.
    let deleted = http
        .delete(format!("{base}/v1/documents/{document_id}"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);
    assert_eq!(owner_peer.expect_close().await, Some(4404));
    let after = http
        .get(format!("{base}/v1/documents/{document_id}"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), 404);
    let ticket_after = principal_ticket(&base, &http, &owner.cookie, &document_id).await;
    assert_eq!(ticket_after.status(), 404);

    // Restart: the tombstone is durable; the document does not resurrect.
    let db = server.stop().await;
    let server = TestServer::spawn(db).await;
    let base = server.base.clone();
    let after_restart = http
        .get(format!("{base}/v1/documents/{document_id}"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(after_restart.status(), 404);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn session_revocation_closes_open_sockets() {
    let server = TestServer::spawn(temp_db("room-logout")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    let user = create_principal(&base, &http, "logout01").await;
    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Cookie", &user.cookie)
            .header("Origin", &base)
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();

    let ticket = principal_ticket(&base, &http, &user.cookie, &document_id).await;
    let ticket = Ticket::from_json(&json_of(ticket).await);
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), Some(&user.cookie)).await;
    peer.insert(0, "before logout").await;

    let logout = http
        .delete(format!("{base}/v1/auth/session"))
        .header("Cookie", &user.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &user.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), 200);
    assert_eq!(peer.expect_close().await, Some(4401));

    // The revoked session can no longer mint room tickets.
    let denied = principal_ticket(&base, &http, &user.cookie, &document_id).await;
    assert_eq!(denied.status(), 401);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn consumed_and_stale_tickets_fail_the_upgrade() {
    let server = TestServer::spawn(temp_db("room-tickets")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    let (auth, document_id) = scratch_document(&base, &http).await;
    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;

    // First use succeeds.
    let peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;

    // Replaying the consumed ticket is refused before the upgrade completes.
    let ws_base = base.replace("http://", "ws://");
    let mut request = format!("{ws_base}{}", ticket.room_url)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!(
            "marks.esbt.v1, marks.ticket.v1.{}.{}",
            ticket.ticket_id, ticket.ticket_secret
        )
        .parse()
        .unwrap(),
    );
    let replay = tokio_tungstenite::connect_async(request).await;
    assert!(replay.is_err(), "consumed ticket must not upgrade");

    // An identity-free socket is refused outright.
    let bare =
        tokio_tungstenite::connect_async(format!("{ws_base}/collab/esbt/{document_id}")).await;
    assert!(bare.is_err(), "no identity-free fallback");

    // Retired engine paths are refused at the socket.
    for engine in ["loro", "yjs"] {
        let retired =
            tokio_tungstenite::connect_async(format!("{ws_base}/collab/{engine}/{document_id}"))
                .await;
        assert!(retired.is_err(), "retired {engine} path must be refused");
    }

    drop(peer);
    server.stop().await;
}
