//! Operational contracts that sit around, but never inside, the ESBT state:
//! read-only health polling, durable-write readiness, and bounded room admission.

mod common;

use common::peer::{Peer, Ticket};
use common::{TestServer, temp_db};
use futures_util::StreamExt;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

fn fresh_doc(site: u128) -> esbt::Document {
    esbt::Document::with_defaults(site).expect("client replica")
}

async fn scratch(base: &str, http: &reqwest::Client) -> (String, String, String, String) {
    let created: serde_json::Value = http
        .post(format!("{base}/v1/auth/scratch"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scratch_id = created["scratchId"].as_str().unwrap().to_owned();
    let capability = created["capability"].as_str().unwrap().to_owned();
    let auth = format!("MarksScratch {scratch_id}.{capability}");
    (scratch_id, capability, auth, base.to_owned())
}

async fn create_document(base: &str, http: &reqwest::Client, auth: &str) -> String {
    let value: serde_json::Value = http
        .post(format!("{base}/v1/documents"))
        .header("Authorization", auth)
        .json(&json!({ "title": "bounded" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    value["document"]["id"].as_str().unwrap().to_owned()
}

async fn ticket_at_site(
    base: &str,
    http: &reqwest::Client,
    auth: &str,
    document_id: &str,
    site: Option<u128>,
) -> Ticket {
    let value: serde_json::Value = http
        .post(format!("{base}/v1/scratch/documents/{document_id}/session"))
        .header("Authorization", auth)
        .json(&json!({ "siteId": site.map(|value| value.to_string()) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    Ticket::from_json(&value)
}

async fn ticket(base: &str, http: &reqwest::Client, auth: &str, document_id: &str) -> Ticket {
    ticket_at_site(base, http, auth, document_id, None).await
}

async fn connect_for_close(base: &str, ticket: &Ticket) -> Option<u16> {
    let ws_base = base.replace("http://", "ws://");
    let mut request = format!("{ws_base}{}", ticket.room_url)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!(
            "marks.esbt.v2, marks.ticket.v1.{}.{}",
            ticket.ticket_id, ticket.ticket_secret
        )
        .parse()
        .unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("capacity socket upgrades before room admission");
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .expect("capacity close timeout")
            .expect("capacity stream ended")
            .expect("capacity socket error")
        {
            Message::Close(frame) => return frame.map(|frame| frame.code.into()),
            _ => continue,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn liveness_polling_is_read_only_and_readiness_tracks_writer_heartbeat() {
    let server = TestServer::spawn_with(temp_db("operational-health"), |config| {
        config.database_heartbeat_ms = 60_000;
        config.database_heartbeat_stale_ms = 120_000;
    })
    .await;
    let http = reqwest::Client::new();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let before = server
        .app
        .db
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT checked_at FROM server_health WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .unwrap();

    for _ in 0..20 {
        let response = http
            .get(format!("{}/healthz", server.base))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let after = server
        .app
        .db
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT checked_at FROM server_health WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .unwrap();
    assert_eq!(before, after, "health-check volume must not create writes");

    let ready: serde_json::Value = http
        .get(format!("{}/readyz", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ready["ok"], true);
    assert!(ready["databaseWriteAt"].as_u64().unwrap() > 0);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn artifact_identity_static_mime_and_security_headers_are_process_owned() {
    let db = temp_db("operational-artifact");
    let static_dir = db.with_extension("static");
    std::fs::create_dir_all(static_dir.join("assets")).unwrap();
    std::fs::write(
        static_dir.join("index.html"),
        "<!doctype html><title>Marks</title>",
    )
    .unwrap();
    let public = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../client/public");
    for name in [
        "esbt.component.wasm",
        "esbt.component.manifest.json",
        "esbt.component.rev",
        "esbt.wit",
    ] {
        std::fs::copy(public.join(name), static_dir.join(name)).unwrap();
    }
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(public.join("esbt.component.manifest.json")).unwrap(),
    )
    .unwrap();
    for module in manifest["core_modules"].as_array().unwrap() {
        let name = module["path"].as_str().unwrap().trim_start_matches('/');
        std::fs::copy(public.join(name), static_dir.join(name)).unwrap();
    }
    std::fs::write(static_dir.join("assets/app-abc.js"), b"export default 1").unwrap();
    let server =
        TestServer::spawn_with(db, |config| config.static_dir = Some(static_dir.clone())).await;
    let http = reqwest::Client::new();

    let artifact = http
        .get(format!("{}/v1/artifact", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(artifact.status(), 200);
    assert_eq!(artifact.headers()["cache-control"], "no-store");
    assert_eq!(artifact.headers()["x-content-type-options"], "nosniff");
    assert!(
        artifact.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("wasm-unsafe-eval")
    );
    let engine_header = artifact.headers()["x-marks-engine"]
        .to_str()
        .unwrap()
        .to_owned();
    let identity: serde_json::Value = artifact.json().await.unwrap();
    assert_eq!(identity["schema"], "marks-artifact.component");
    assert_eq!(identity["serverEngineRevision"], engine_header);
    assert_eq!(identity["staticArtifactVerified"], true);
    assert_eq!(identity["profileCoherent"], true);
    assert_eq!(identity["engineCoherent"], true);
    assert_eq!(
        identity["releaseReady"], false,
        "a development build is never a release receipt"
    );

    let html = http.get(format!("{}/", server.base)).send().await.unwrap();
    assert_eq!(html.status(), 200);
    assert!(
        html.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert_eq!(html.headers()["cache-control"], "no-cache, must-revalidate");

    let component = http
        .get(format!("{}/esbt.component.wasm", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(component.headers()["content-type"], "application/wasm");
    assert_eq!(
        component.headers()["cache-control"],
        "no-cache, must-revalidate"
    );

    let script = http
        .get(format!("{}/assets/app-abc.js", server.base))
        .send()
        .await
        .unwrap();
    assert!(
        script.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("javascript")
    );
    assert_eq!(
        script.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );

    server.stop().await;
    let _ = std::fs::remove_dir_all(static_dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn peer_and_resident_room_capacity_fail_with_retryable_close_code() {
    let server = TestServer::spawn_with(temp_db("operational-capacity"), |config| {
        config.max_connections_per_room = 2;
        config.max_resident_rooms = 1;
    })
    .await;
    let http = reqwest::Client::new();
    let (_, _, auth, base) = scratch(&server.base, &http).await;
    let first_document = create_document(&base, &http, &auth).await;
    let second_document = create_document(&base, &http, &auth).await;

    let first_ticket = ticket(&base, &http, &auth, &first_document).await;
    let first = Peer::connect(&base, &first_ticket, fresh_doc(first_ticket.site), None).await;
    let second_ticket = ticket(&base, &http, &auth, &first_document).await;
    let second = Peer::connect(&base, &second_ticket, fresh_doc(second_ticket.site), None).await;

    let over_peer = ticket(&base, &http, &auth, &first_document).await;
    assert_eq!(connect_for_close(&base, &over_peer).await, Some(4429));

    let over_room = ticket(&base, &http, &auth, &second_document).await;
    assert_eq!(connect_for_close(&base, &over_room).await, Some(4429));

    drop(first);
    drop(second);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mutation_budget_closes_the_transport_but_preserves_retry_recovery() {
    let server = TestServer::spawn_with(temp_db("operational-rate"), |config| {
        config.max_mutations_per_second = 1;
    })
    .await;
    let http = reqwest::Client::new();
    let (_, _, auth, base) = scratch(&server.base, &http).await;
    let document_id = create_document(&base, &http, &auth).await;
    let first_ticket = ticket(&base, &http, &auth, &document_id).await;
    let site = first_ticket.site;
    let mut peer = Peer::connect(&base, &first_ticket, fresh_doc(site), None).await;

    let first = peer
        .doc
        .insert(0, "a", None)
        .unwrap()
        .expect("first update");
    let second = peer
        .doc
        .insert(1, "b", None)
        .unwrap()
        .expect("second update");
    peer.send_mutation(
        marks_server::room::protocol::MutationKind::Update,
        &first.canonical_bytes,
    )
    .await;
    peer.send_mutation(
        marks_server::room::protocol::MutationKind::Update,
        &second.canonical_bytes,
    )
    .await;
    assert_eq!(peer.expect_close().await, Some(4429));

    // The accepted prefix committed even though its ACK could not be delivered;
    // the local replica still contains both edits and resends the missing tail
    // under its stable site on the next one-use ticket.
    let offline = peer.disconnect().await;
    let reconnect = ticket_at_site(&base, &http, &auth, &document_id, Some(site)).await;
    let mut recovered = Peer::connect(&base, &reconnect, offline, None).await;
    recovered.converge_to("ab").await;
    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "ab");
    server.stop().await;
}
