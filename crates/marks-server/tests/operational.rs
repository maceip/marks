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
    assert_eq!(ready["productVariant"], env!("MARKS_PRODUCT_VARIANT"));
    assert_eq!(ready["buildPlanSha256"], env!("MARKS_BUILD_PLAN_SHA256"));
    assert_eq!(
        ready["features"]["agent-chat"],
        cfg!(feature = "agent-chat")
    );
    assert_eq!(ready["staticBuildPlanVerified"], false);
    server.stop().await;
}

#[cfg(not(feature = "agent-chat"))]
#[tokio::test(flavor = "multi_thread")]
async fn stable_server_physically_omits_agent_routes_and_capability() {
    let server = TestServer::spawn(temp_db("operational-no-agent")).await;
    let http = reqwest::Client::new();
    for path in [
        "/v1/agent/capabilities",
        "/v1/agent/runs",
        "/v1/agent/runs/run_missing/events",
        "/v1/agent/runs/run_missing/tool-results",
        "/v1/agent/runs/run_missing",
    ] {
        let response = http
            .get(format!("{}{path}", server.base))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404, "stable route {path} must be absent");
    }
    assert!(!server.app.artifact.features["agent-chat"]);
    assert!(server.app.artifact.server_features.is_empty());
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
    std::fs::write(
        static_dir.join("marks-product-build.json"),
        format!(
            "{{\"buildPlan\":{},\"buildPlanSha256\":\"{}\",\"schema\":\"marks.product-build-receipt.v1\"}}",
            env!("MARKS_BUILD_PLAN_JSON"),
            env!("MARKS_BUILD_PLAN_SHA256"),
        ),
    )
    .unwrap();
    std::fs::write(static_dir.join("assets/app-abc.js"), b"export default 1").unwrap();
    let pool_dir = static_dir.with_extension("asset-pool");
    std::fs::create_dir_all(&pool_dir).unwrap();
    std::fs::write(pool_dir.join("app-old1.js"), b"export default 0").unwrap();
    let server = TestServer::spawn_with(db, |config| {
        config.static_dir = Some(static_dir.clone());
        config.asset_pool = Some(pool_dir.clone());
    })
    .await;
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
    assert_eq!(identity["staticBuildPlanVerified"], true);
    assert_eq!(identity["productVariant"], env!("MARKS_PRODUCT_VARIANT"));
    assert_eq!(identity["buildPlanSha256"], env!("MARKS_BUILD_PLAN_SHA256"));
    assert_eq!(
        identity["features"]["agent-chat"],
        cfg!(feature = "agent-chat")
    );
    assert_eq!(identity["profileCoherent"], true);
    assert_eq!(identity["engineCoherent"], true);
    let embedded_plan: serde_json::Value =
        serde_json::from_str(env!("MARKS_BUILD_PLAN_JSON")).unwrap();
    assert_eq!(identity["buildRevision"], env!("MARKS_BUILD_REVISION"));
    assert_eq!(identity["buildPlan"], embedded_plan);
    assert_eq!(
        identity["serverSourceDirty"],
        env!("MARKS_SOURCE_DIRTY") == "1"
    );
    let expected_release_ready = env!("MARKS_BUILD_REVISION") != "development"
        && embedded_plan["deployable"] == true
        && embedded_plan["client"]["dataMode"] == "service"
        && identity["componentSourceDirty"] == false
        && env!("MARKS_SOURCE_DIRTY") == "0";
    assert_eq!(
        identity["releaseReady"], expected_release_ready,
        "a coherent verified fixture is release-ready exactly for a clean, revision-bound, deployable service cut"
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

    // A previous release's hashed chunk resolves from the shared retained
    // pool with the same immutable policy, so a tab opened before a
    // deployment keeps loading its lazy chunks until it reloads.
    let pooled = http
        .get(format!("{}/assets/app-old1.js", server.base))
        .header("accept", "*/*")
        .header("sec-fetch-mode", "cors")
        .send()
        .await
        .unwrap();
    assert_eq!(pooled.status(), 200);
    assert_eq!(
        pooled.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert!(
        pooled.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("javascript")
    );

    // A missing hashed asset — absent from the active release and from every
    // retained release — must be an uncacheable 404, never the SPA shell:
    // immutable HTML under a JavaScript URL would poison the browser cache
    // beyond rollback.
    let missing_asset = http
        .get(format!("{}/assets/app-gone.js", server.base))
        .header("accept", "*/*")
        .header("sec-fetch-mode", "cors")
        .send()
        .await
        .unwrap();
    assert_eq!(missing_asset.status(), 404);
    assert_eq!(missing_asset.headers()["cache-control"], "no-store");

    // Even an address-bar navigation to a missing asset path stays a 404.
    let asset_navigation = http
        .get(format!("{}/assets/app-gone.js", server.base))
        .header("accept", "text/html,application/xhtml+xml")
        .header("sec-fetch-mode", "navigate")
        .send()
        .await
        .unwrap();
    assert_eq!(asset_navigation.status(), 404);

    // Deep-link navigations still receive the app shell.
    let deep_link = http
        .get(format!("{}/documents/2f9d1c", server.base))
        .header("accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .header("sec-fetch-mode", "navigate")
        .send()
        .await
        .unwrap();
    assert_eq!(deep_link.status(), 200);
    assert!(
        deep_link.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert_eq!(
        deep_link.headers()["cache-control"],
        "no-cache, must-revalidate"
    );

    // Browsers without fetch metadata still navigate through Accept.
    let legacy_navigation = http
        .get(format!("{}/documents/2f9d1c", server.base))
        .header("accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .unwrap();
    assert_eq!(legacy_navigation.status(), 200);

    // Firefox does not preserve `Sec-Fetch-Mode: navigate` on a navigation
    // its service worker passes through with fetch(event.request); the
    // Accept preference must be sufficient on its own or every reload of a
    // deep link under the worker becomes an empty-response error page.
    let forwarded_navigation = http
        .get(format!("{}/documents/2f9d1c", server.base))
        .header(
            "accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("sec-fetch-mode", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(forwarded_navigation.status(), 200);
    assert!(
        forwarded_navigation.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert!(
        legacy_navigation.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );

    // Non-navigation lookups of unknown runtime paths are honest 404s, so a
    // stale service worker or loader can detect a missing artifact instead
    // of parsing shell HTML as WebAssembly or JavaScript.
    let missing_runtime = http
        .get(format!("{}/esbt.core9.wasm", server.base))
        .header("accept", "*/*")
        .header("sec-fetch-mode", "cors")
        .send()
        .await
        .unwrap();
    assert_eq!(missing_runtime.status(), 404);

    server.stop().await;
    let _ = std::fs::remove_dir_all(static_dir);
    let _ = std::fs::remove_dir_all(pool_dir);
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
