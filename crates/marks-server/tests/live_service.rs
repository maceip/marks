//! Two native ESBT peers against a **running production binary**.
//!
//! Ignored unless CI (or a human) points `MARKS_URL` at `marks-server`.
//! When `MARKS_CI_RECEIPT` is set, the document was created by the
//! service-mode browser; the peers must still converge on that row.

#![cfg(test)]

mod common;

use common::peer::{Peer, Ticket};
use serde_json::{Value, json};

fn required_url() -> String {
    std::env::var("MARKS_URL")
        .expect("MARKS_URL must point at a running marks-server")
        .trim_end_matches('/')
        .to_owned()
}

async fn json_of(response: reqwest::Response) -> Value {
    response.json::<Value>().await.expect("json body")
}

struct ScratchDoc {
    auth: String,
    document_id: String,
}

fn receipt_doc() -> Option<ScratchDoc> {
    let path = std::env::var("MARKS_CI_RECEIPT").ok()?;
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("MARKS_CI_RECEIPT {path} is unreadable: {error}");
    });
    let value: Value = serde_json::from_str(&raw).expect("receipt json");
    let scratch_id = value["scratchId"].as_str().expect("receipt.scratchId");
    let capability = value["capability"].as_str().expect("receipt.capability");
    let document_id = value["documentId"].as_str().expect("receipt.documentId");
    Some(ScratchDoc {
        auth: format!("MarksScratch {scratch_id}.{capability}"),
        document_id: document_id.to_owned(),
    })
}

async fn scratch_document(base: &str, http: &reqwest::Client) -> ScratchDoc {
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
    ScratchDoc {
        auth,
        document_id: created["document"]["id"].as_str().unwrap().to_owned(),
    }
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
    assert_eq!(
        response.status(),
        200,
        "scratch room admission against the live binary"
    );
    Ticket::from_json(&json_of(response).await)
}

fn fresh_doc(site: u128) -> esbt::Document {
    esbt::Document::with_defaults(site).expect("client replica")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires MARKS_URL against a running marks-server binary"]
async fn production_binary_two_peers_converge_on_service_document() {
    let base = required_url();
    let http = reqwest::Client::new();

    let health = http
        .get(format!("{base}/healthz"))
        .send()
        .await
        .expect("healthz");
    assert_eq!(health.status(), 200, "live binary must answer /healthz");
    let body = json_of(health).await;
    assert_eq!(body["ok"], true);

    let doc = match receipt_doc() {
        Some(doc) => doc,
        None => scratch_document(&base, &http).await,
    };
    let from_ui = std::env::var("MARKS_CI_RECEIPT").is_ok();
    if from_ui {
        let listed = json_of(
            http.get(format!("{base}/v1/documents"))
                .header("Authorization", &doc.auth)
                .send()
                .await
                .unwrap(),
        )
        .await;
        let ids: Vec<&str> = listed["documents"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["id"].as_str())
            .collect();
        assert!(
            ids.contains(&doc.document_id.as_str()),
            "UI-created {} missing from catalog: {ids:?}",
            doc.document_id
        );
    }

    let ticket_a = scratch_ticket(&base, &http, &doc.auth, &doc.document_id, None).await;
    let mut peer_a = Peer::connect(&base, &ticket_a, fresh_doc(ticket_a.site), None).await;
    let initial = peer_a.doc.text();
    peer_a.insert(peer_a.doc.len(), "Peer A from CI.").await;
    let after_a = format!("{initial}Peer A from CI.");

    let ticket_b = scratch_ticket(&base, &http, &doc.auth, &doc.document_id, None).await;
    let mut peer_b = Peer::connect(&base, &ticket_b, fresh_doc(ticket_b.site), None).await;
    peer_b.converge_to(&after_a).await;

    let len = peer_b.doc.len();
    peer_b.insert(len, " Peer B from CI.").await;
    let expected = format!("{after_a} Peer B from CI.");
    peer_a.converge_to(&expected).await;
    assert_eq!(peer_a.doc.text(), peer_b.doc.text());

    let exported = http
        .get(format!("{base}/v1/documents/{}/export", doc.document_id))
        .header("Authorization", &doc.auth)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(
        exported, expected,
        "export must read the live journal, not an empty local replica"
    );
}
