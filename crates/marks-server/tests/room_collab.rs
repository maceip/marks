//! Durable room behavior with real ESBT-web replicas over real WebSockets:
//! convergence, offline deltas, role enforcement, live revocation, deletion,
//! and journal-backed restart recovery.

mod common;

use common::peer::{Peer, PeerEvent, Ticket};
use common::{TestServer, create_principal, temp_db};
use marks_server::room::protocol::MutationKind;
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

async fn connection_count(
    base: &str,
    http: &reqwest::Client,
    auth: &str,
    document_id: &str,
) -> u64 {
    let response = http
        .get(format!("{base}/v1/documents/{document_id}"))
        .header("Authorization", auth)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    json_of(response).await["connections"].as_u64().unwrap()
}

fn fresh_doc(site: u128) -> esbt::Document {
    esbt::Document::with_defaults(site).expect("client replica")
}

#[tokio::test(flavor = "multi_thread")]
async fn document_metadata_reads_the_cheap_live_connection_counter() {
    let server = TestServer::spawn(temp_db("room-connection-counter")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (auth, document_id) = scratch_document(&base, &http).await;
    assert_eq!(connection_count(&base, &http, &auth, &document_id).await, 0);

    let first_ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let first = Peer::connect(&base, &first_ticket, fresh_doc(first_ticket.site), None).await;
    assert_eq!(connection_count(&base, &http, &auth, &document_id).await, 1);

    let second_ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let second = Peer::connect(&base, &second_ticket, fresh_doc(second_ticket.site), None).await;
    assert_eq!(connection_count(&base, &http, &auth, &document_id).await, 2);

    drop(first);
    drop(second);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mutations_cannot_forge_another_room_site_through_updates_or_snapshots() {
    let server = TestServer::spawn(temp_db("room-site-binding")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (auth, document_id) = scratch_document(&base, &http).await;

    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    let mut forged = fresh_doc(999);
    let update = forged.insert(0, "forged update", None).unwrap().unwrap();
    peer.send_mutation(MutationKind::Update, &update.canonical_bytes)
        .await;
    assert_eq!(peer.expect_close().await, Some(4400));

    let ticket = scratch_ticket(&base, &http, &auth, &document_id, Some(ticket.site)).await;
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    let snapshot = forged.export_compact_snapshot().unwrap();
    peer.send_mutation(MutationKind::Snapshot, &snapshot).await;
    assert_eq!(peer.expect_close().await, Some(4400));

    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(exported.status(), 200);
    assert_eq!(exported.text().await.unwrap(), "");
    server
        .app
        .db
        .read(|conn| {
            let updates: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_updates WHERE document_id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            let ranges: i64 = conn.query_row(
                "SELECT COUNT(*) FROM op_author_ranges WHERE document_id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            assert_eq!((updates, ranges), (0, 0));
            Ok(())
        })
        .unwrap();

    server.stop().await;
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
        .get(format!(
            "{base}/v1/scratch/documents/{document_id}/snapshot"
        ))
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
async fn seeded_public_scratch_document_survives_restart_before_any_edit() {
    let server = TestServer::spawn(temp_db("room-public-seeded-restart")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let initial_markdown = "# Google Docs for Markdown\n\nStart writing together immediately.\n";

    let creator = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let creator_auth = format!(
        "MarksScratch {}.{}",
        creator["scratchId"].as_str().unwrap(),
        creator["capability"].as_str().unwrap()
    );
    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Authorization", &creator_auth)
            .json(&json!({
                "title": "Google Docs for Markdown",
                "markdown": initial_markdown,
            }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["document"]["slug"], document_id);
    assert_eq!(created["document"]["public"], true);
    assert_eq!(created["document"]["anonymous_edits"], 0);
    assert_eq!(created["document"]["persisted"], false);

    let db = server.stop().await;
    let server = TestServer::spawn(db).await;
    let base = server.base.clone();

    let visitor = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let visitor_auth = format!(
        "MarksScratch {}.{}",
        visitor["scratchId"].as_str().unwrap(),
        visitor["capability"].as_str().unwrap()
    );
    let visible = http
        .get(format!("{base}/v1/documents/{document_id}"))
        .header("Authorization", &visitor_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(visible.status(), 200);
    let visible = json_of(visible).await;
    assert_eq!(visible["document"]["slug"], document_id);
    assert_eq!(visible["document"]["public"], true);
    assert_eq!(visible["document"]["public_role"], "editor");
    assert_eq!(visible["document"]["anonymous_edits"], 0);
    assert_eq!(visible["document"]["persisted"], false);

    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Authorization", &visitor_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(exported.status(), 200);
    assert_eq!(exported.text().await.unwrap(), initial_markdown);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn anonymous_slug_is_public_and_survives_its_creator_after_seven_edits() {
    let server = TestServer::spawn(temp_db("room-public-anonymous")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (owner_auth, document_id) = scratch_document(&base, &http).await;

    let owner_meta = json_of(
        http.get(format!("{base}/v1/documents/{document_id}"))
            .header("Authorization", &owner_auth)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(owner_meta["document"]["slug"], document_id);
    assert_eq!(owner_meta["document"]["public"], true);
    assert_eq!(owner_meta["document"]["public_role"], "editor");
    assert_eq!(owner_meta["document"]["persisted"], false);

    let visitor = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let visitor_auth = format!(
        "MarksScratch {}.{}",
        visitor["scratchId"].as_str().unwrap(),
        visitor["capability"].as_str().unwrap()
    );
    let visible = http
        .get(format!("{base}/v1/documents/{document_id}"))
        .header("Authorization", &visitor_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(
        visible.status(),
        200,
        "the slug itself grants public edit access"
    );

    let owner_ticket_body = json_of(
        http.post(format!("{base}/v1/scratch/documents/{document_id}/session"))
            .header("Authorization", &owner_auth)
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(
        owner_ticket_body["role"].is_null(),
        "the creator remains owner"
    );

    let visitor_ticket_body = json_of(
        http.post(format!("{base}/v1/scratch/documents/{document_id}/session"))
            .header("Authorization", &visitor_auth)
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visitor_ticket_body["role"], "editor");
    let visitor_ticket = Ticket::from_json(&visitor_ticket_body);
    let mut peer =
        Peer::connect(&base, &visitor_ticket, fresh_doc(visitor_ticket.site), None).await;
    for _ in 0..7 {
        peer.insert(peer.doc.len(), "x").await;
    }

    let milestone = server
        .app
        .db
        .read(|conn| {
            conn.query_row(
                "SELECT public_edit, anonymous_edit_count, persisted_at IS NOT NULL
                 FROM documents WHERE id = ?1",
                [&document_id],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .map_err(Into::into)
        })
        .expect("anonymous persistence milestone");
    assert_eq!(milestone, (true, 7, true));

    let owner_scratch_id = owner_auth
        .strip_prefix("MarksScratch ")
        .unwrap()
        .split_once('.')
        .unwrap()
        .0;
    server
        .app
        .db
        .tx(|conn| {
            conn.execute(
                "UPDATE scratch_workspaces SET expires_at = 0 WHERE id = ?1",
                [owner_scratch_id],
            )?;
            Ok(())
        })
        .unwrap();

    let member = create_principal(&base, &http, "publicmember").await;
    let member_ticket_response = principal_ticket(&base, &http, &member.cookie, &document_id).await;
    assert_eq!(member_ticket_response.status(), 200);
    let member_ticket_body = json_of(member_ticket_response).await;
    assert_eq!(member_ticket_body["role"], "editor");
    let member_ticket = Ticket::from_json(&member_ticket_body);
    let mut member_peer = Peer::connect(
        &base,
        &member_ticket,
        fresh_doc(member_ticket.site),
        Some(&member.cookie),
    )
    .await;
    member_peer.converge_to("xxxxxxx").await;

    drop(peer);
    drop(member_peer);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn recovery_snapshot_is_one_atomic_revision_and_retry_safe_across_crash() {
    let server = TestServer::spawn(temp_db("room-snapshot-commit")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (auth, document_id) = scratch_document(&base, &http).await;
    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;

    peer.doc
        .insert(0, "Recovered exactly once.", None)
        .expect("local snapshot edit")
        .expect("snapshot update");
    let snapshot = peer
        .doc
        .export_compact_snapshot()
        .expect("compact recovery snapshot");
    let expected_last_sequence = peer.doc.version().observed(ticket.site);
    let message_id = [42_u8; 16];
    peer.send_mutation_with_id(message_id, MutationKind::Snapshot, &snapshot)
        .await;
    let revision = peer.wait_committed(message_id).await;
    assert_eq!(revision, 1);

    // Losing an ACK and replaying the exact envelope is a receipt lookup. It
    // does not create a second revision or re-run snapshot persistence.
    peer.send_mutation_with_id(message_id, MutationKind::Snapshot, &snapshot)
        .await;
    assert_eq!(peer.wait_committed(message_id).await, revision);
    let counts = server
        .app
        .db
        .read(|conn| {
            let commits: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_commits WHERE document_id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            let updates: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_updates WHERE document_id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            let snapshot_revision: i64 = conn.query_row(
                "SELECT snapshot_revision FROM documents WHERE id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            let range: (String, i64, i64) = conn.query_row(
                "SELECT site, first_seq, last_seq FROM op_author_ranges
                 WHERE document_id = ?1",
                [&document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            Ok((commits, updates, snapshot_revision, range))
        })
        .expect("receipt rows");
    assert_eq!(counts.0, 1);
    assert_eq!(counts.1, 0);
    assert_eq!(counts.2, 1);
    assert_eq!(
        counts.3,
        (ticket.site.to_string(), 1, expected_last_sequence as i64)
    );

    // The same ID cannot be rebound to a different payload or kind.
    let conflicting = peer
        .doc
        .insert(peer.doc.len(), " conflict", None)
        .expect("conflicting local edit")
        .expect("conflicting update");
    peer.send_mutation_with_id(
        message_id,
        MutationKind::Update,
        &conflicting.canonical_bytes,
    )
    .await;
    assert_eq!(peer.expect_close().await, Some(4400));

    // Abort the process without the room shutdown/compaction path. The one
    // acknowledged snapshot revision remains the restart authority.
    let db = server.crash().await;
    let restarted = TestServer::spawn(db).await;
    let exported = http
        .get(format!(
            "{}/v1/documents/{}/export",
            restarted.base, document_id
        ))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(exported, "Recovered exactly once.");
    restarted.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_room_releases_replica_and_rehydrates_on_next_join() {
    let server = TestServer::spawn(temp_db("room-idle-eviction")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (auth, document_id) = scratch_document(&base, &http).await;
    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    peer.insert(0, "Evict me safely.").await;
    assert_eq!(server.app.rooms.resident_count().await, 1);
    let _ = peer.disconnect().await;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while server.app.rooms.resident_count().await != 0 {
        assert!(std::time::Instant::now() < deadline, "room did not evict");
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut reopened = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    reopened.converge_to("Evict me safely.").await;
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn large_transactions_trigger_operation_bounded_compaction() {
    let server = TestServer::spawn(temp_db("room-operation-compaction")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (auth, document_id) = scratch_document(&base, &http).await;
    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    peer.insert(0, &"a".repeat(20_000)).await;
    peer.insert(20_000, &"b".repeat(20_000)).await;

    let durable = server
        .app
        .db
        .read(|conn| {
            let row: (i64, i64, bool) = conn.query_row(
                "SELECT snapshot_revision,
                        (SELECT COUNT(*) FROM document_updates WHERE document_id = ?1),
                        snapshot IS NOT NULL
                 FROM documents WHERE id = ?1",
                [&document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            Ok(row)
        })
        .expect("compacted rows");
    assert_eq!(durable, (2, 0, true));

    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut cold = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    cold.converge_to(&format!("{}{}", "a".repeat(20_000), "b".repeat(20_000)))
        .await;
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn consecutive_mutations_share_one_durable_commit_without_sharing_revisions() {
    let server = TestServer::spawn(temp_db("room-group-commit")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let (auth, document_id) = scratch_document(&base, &http).await;
    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    let before = server.app.rooms.commit_stats();

    let mut ids = Vec::new();
    for _ in 0..12 {
        let update = peer
            .doc
            .insert(peer.doc.len(), "x", None)
            .expect("local insert")
            .expect("local update");
        ids.push(
            peer.send_mutation(MutationKind::Update, &update.canonical_bytes)
                .await,
        );
    }

    let mut revisions = std::collections::HashMap::new();
    while revisions.len() < ids.len() {
        match peer.next_event().await {
            PeerEvent::Committed(id, revision) => {
                revisions.insert(id, revision);
            }
            PeerEvent::Closed(code) => panic!("closed before group commit: {code:?}"),
            _ => {}
        }
    }
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(revisions[id], index as u64 + 1);
    }
    let after = server.app.rooms.commit_stats();
    assert_eq!(after.mutations - before.mutations, 12);
    assert_eq!(
        after.batches - before.batches,
        1,
        "the room should pay for one FULL-sync commit, not twelve"
    );

    // Compaction is folded into that same transaction once the row threshold
    // is crossed; a cold reader still sees all twelve independent revisions.
    let durable = server
        .app
        .db
        .read(|connection| {
            connection
                .query_row(
                    "SELECT snapshot_revision,
                            (SELECT COUNT(*) FROM document_updates WHERE document_id = ?1)
                     FROM documents WHERE id = ?1",
                    [&document_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(Into::into)
        })
        .expect("durable group commit");
    assert_eq!(durable, (12, 0));

    let ticket = scratch_ticket(&base, &http, &auth, &document_id, None).await;
    let mut cold = Peer::connect(&base, &ticket, fresh_doc(ticket.site), None).await;
    cold.converge_to("xxxxxxxxxxxx").await;
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
    guest_peer
        .send_mutation(MutationKind::Update, &forged.canonical_bytes)
        .await;
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
async fn durable_commit_revalidates_session_when_control_delivery_is_missed() {
    let server = TestServer::spawn(temp_db("room-revocation-transaction")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let user = create_principal(&base, &http, "revtx001").await;
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
    let ticket = Ticket::from_json(
        &json_of(principal_ticket(&base, &http, &user.cookie, &document_id).await).await,
    );
    let mut peer = Peer::connect(&base, &ticket, fresh_doc(ticket.site), Some(&user.cookie)).await;

    // Simulate a committed revocation whose best-effort in-memory signal was
    // lost. The next mutation must still fail inside its own durable SQLite
    // transaction and leave no journal row behind.
    server
        .app
        .db
        .tx(|conn| {
            conn.execute(
                "UPDATE sessions SET revoked_at = ?2 WHERE principal_id = ?1",
                rusqlite::params![
                    user.principal_id,
                    marks_server::store::ms(marks_server::ids::now_ms())
                ],
            )?;
            Ok(())
        })
        .unwrap();
    let update = peer
        .doc
        .insert(0, "must not persist", None)
        .unwrap()
        .unwrap();
    peer.send_mutation(MutationKind::Update, &update.canonical_bytes)
        .await;
    assert_eq!(peer.expect_close().await, Some(4401));

    server
        .app
        .db
        .read(|conn| {
            let updates: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_updates WHERE document_id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            let chars: i64 = conn.query_row(
                "SELECT chars FROM documents WHERE id = ?1",
                [&document_id],
                |row| row.get(0),
            )?;
            assert_eq!((updates, chars), (0, 0));
            Ok(())
        })
        .unwrap();
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
            "marks.esbt.v2, marks.ticket.v1.{}.{}",
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
