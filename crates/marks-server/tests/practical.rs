//! Integration coverage for the practical ribbon's deliberately narrow
//! protected-interface additions. External providers are not contacted here;
//! auth, disclosure, input bounds, asset metadata, and SSRF refusal are real.

mod common;

use common::{Principal, TestServer, create_principal, temp_db};
use serde_json::{Value, json};

async fn create_document(
    base: &str,
    http: &reqwest::Client,
    owner: &Principal,
) -> String {
    let response = http
        .post(format!("{base}/v1/documents"))
        .header("Cookie", &owner.cookie)
        .header("Origin", base)
        .json(&json!({ "title": "Practical ribbon", "markdown": "# Private\n" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    response.json::<Value>().await.unwrap()["document"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn png() -> Vec<u8> {
    b"\x89PNG\r\n\x1a\npractical".to_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn practical_routes_require_document_authority_origin_and_csrf() {
    let server = TestServer::spawn(temp_db("practical-authority")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "practical-owner").await;
    let stranger = create_principal(&base, &http, "practical-stranger").await;
    let document_id = create_document(&base, &http, &owner).await;
    let route = format!("{base}/v1/documents/{document_id}/link-checks");

    let missing_csrf = http
        .post(&route)
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "urls": ["http://127.0.0.1/private"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_csrf.status(), 403);

    let cross_origin = http
        .post(&route)
        .header("Cookie", &owner.cookie)
        .header("Origin", "https://attacker.invalid")
        .header("X-Marks-CSRF", &owner.csrf)
        .json(&json!({ "urls": ["http://127.0.0.1/private"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_origin.status(), 403);

    let hidden = http
        .post(&route)
        .header("Cookie", &stranger.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &stranger.csrf)
        .json(&json!({ "urls": ["http://127.0.0.1/private"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 404);

    let hidden_assets = http
        .get(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &stranger.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(hidden_assets.status(), 404);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn link_checker_is_bounded_and_refuses_non_public_destinations_without_fetching_them() {
    let server = TestServer::spawn(temp_db("practical-ssrf")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "practical-ssrf-owner").await;
    let document_id = create_document(&base, &http, &owner).await;
    let route = format!("{base}/v1/documents/{document_id}/link-checks");
    let urls = [
        "http://127.0.0.1/private",
        "http://[::1]/private",
        "http://user:pass@example.com/private",
        "file:///etc/passwd",
    ];

    let checked = http
        .post(&route)
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .json(&json!({ "urls": urls }))
        .send()
        .await
        .unwrap();
    assert_eq!(checked.status(), 200);
    let body: Value = checked.json().await.unwrap();
    assert_eq!(body["checks"].as_array().unwrap().len(), urls.len());
    assert!(
        body["checks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "blocked")
    );

    let too_many = (0..33)
        .map(|index| format!("https://example.com/{index}"))
        .collect::<Vec<_>>();
    let bounded = http
        .post(&route)
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .json(&json!({ "urls": too_many }))
        .send()
        .await
        .unwrap();
    assert_eq!(bounded.status(), 400);

    let malformed_doi = http
        .post(format!(
            "{base}/v1/documents/{document_id}/citation-lookup"
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .json(&json!({ "doi": "https://127.0.0.1/not-a-doi" }))
        .send()
        .await
        .unwrap();
    assert_eq!(malformed_doi.status(), 400);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn asset_inspector_lists_bounded_metadata_to_readers_without_blob_or_hash_disclosure() {
    let server = TestServer::spawn(temp_db("practical-assets")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "practical-asset-owner").await;
    let viewer = create_principal(&base, &http, "practical-asset-viewer").await;
    let document_id = create_document(&base, &http, &owner).await;

    let uploaded: Value = http
        .post(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-Filename", "proof.png")
        .body(png())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(uploaded["asset"]["id"].is_string());

    let shared = http
        .put(format!(
            "{base}/v1/documents/{document_id}/shares/{}",
            viewer.principal_id
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "role": "viewer" }))
        .send()
        .await
        .unwrap();
    assert_eq!(shared.status(), 200);

    let response = http
        .get(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &viewer.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    let asset = &body["assets"][0];
    assert_eq!(asset["filename"], "proof.png");
    assert_eq!(asset["mediaType"], "image/png");
    assert!(asset["bytes"].is_number());
    assert!(asset["url"].is_string());
    assert!(asset.get("hash").is_none());
    assert!(asset.get("content").is_none());

    server.stop().await;
}
