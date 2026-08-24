mod common;

use common::{TestServer, create_principal, temp_db};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

fn png(suffix: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\nasset".to_vec();
    bytes.push(suffix);
    bytes
}

fn stored_path(root: &Path, bytes: &[u8]) -> PathBuf {
    let hash = Sha256::digest(bytes);
    let encoded = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    root.join(&encoded[..2]).join(&encoded[2..])
}

#[tokio::test(flavor = "multi_thread")]
async fn assets_are_sniffed_quota_bounded_deduplicated_and_revoked_with_document() {
    let server = TestServer::spawn_with(temp_db("assets"), |config| {
        config.max_asset_bytes = 1024;
        config.max_asset_bytes_per_document = 20;
    })
    .await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "assetowner").await;
    let viewer = create_principal(&base, &http, "assetviewer").await;
    let created: Value = http
        .post(format!("{base}/v1/documents"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "title": "Assets" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let document_id = created["document"]["id"].as_str().unwrap();
    http.put(format!(
        "{base}/v1/documents/{document_id}/shares/{}",
        viewer.principal_id
    ))
    .header("Cookie", &owner.cookie)
    .header("Origin", &base)
    .json(&json!({ "role": "viewer" }))
    .send()
    .await
    .unwrap();

    let forbidden = http
        .post(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &viewer.cookie)
        .header("Origin", &base)
        .header("x-marks-filename", "viewer.png")
        .body(png(1))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let first: Value = http
        .post(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("x-marks-filename", "proof.png")
        .header("Content-Type", "text/html")
        .body(png(1))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let asset_id = first["asset"]["id"].as_str().unwrap();
    assert_eq!(first["asset"]["mediaType"], "image/png");
    assert_eq!(
        first["asset"]["url"],
        format!("/a/{document_id}/{asset_id}")
    );

    let duplicate: Value = http
        .post(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("x-marks-filename", "other-name.png")
        .body(png(1))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(duplicate["asset"]["id"], asset_id);
    server
        .app
        .db
        .read(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_assets WHERE document_id = ?1",
                [document_id],
                |row| row.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(())
        })
        .unwrap();

    let asset_url = first["asset"]["url"].as_str().unwrap();
    let markdown = format!("![proof]({asset_url})\n");
    let mut document = esbt::Document::new(
        marks_auth::EsbtSiteId::SERVER.to_engine_site(),
        esbt::ReplicaConfig::default(),
        server.app.limits.clone(),
    )
    .unwrap();
    document.insert(0, &markdown, None).unwrap();
    let snapshot = document.export_compact_snapshot().unwrap();
    server
        .app
        .db
        .tx(|conn| {
            conn.execute(
                "UPDATE documents SET snapshot = ?2, chars = ?3 WHERE id = ?1",
                rusqlite::params![
                    document_id,
                    snapshot,
                    markdown.encode_utf16().count() as i64
                ],
            )?;
            Ok(())
        })
        .unwrap();

    let bundle = http
        .get(format!("{base}/v1/documents/{document_id}/export-bundle"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(bundle.status(), 200);
    assert!(bundle.headers().get("content-length").is_none());
    let bytes = bundle.bytes().await.unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut bundled_markdown = String::new();
    zip.by_name("document.md")
        .unwrap()
        .read_to_string(&mut bundled_markdown)
        .unwrap();
    let path = format!("assets/{asset_id}.png");
    assert_eq!(bundled_markdown, format!("![proof]({path})\n"));
    let mut bundled_asset = Vec::new();
    zip.by_name(&path)
        .unwrap()
        .read_to_end(&mut bundled_asset)
        .unwrap();
    assert_eq!(bundled_asset, png(1));

    let fetched = http
        .get(format!("{base}/a/{document_id}/{asset_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(fetched.status(), 200);
    assert_eq!(fetched.headers()["content-type"], "image/png");
    assert_eq!(
        fetched.headers()["content-length"].to_str().unwrap(),
        png(1).len().to_string()
    );
    assert_eq!(fetched.bytes().await.unwrap().as_ref(), png(1));

    let over_quota = http
        .post(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("x-marks-filename", "second.png")
        .body(png(2))
        .send()
        .await
        .unwrap();
    assert_eq!(over_quota.status(), 400);

    http.delete(format!("{base}/v1/documents/{document_id}"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .send()
        .await
        .unwrap();
    assert_eq!(
        http.get(format!("{base}/a/{document_id}/{asset_id}"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    http.post(format!("{base}/v1/documents/{document_id}/restore"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        http.get(format!("{base}/a/{document_id}/{asset_id}"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    http.delete(format!("{base}/v1/documents/{document_id}"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .send()
        .await
        .unwrap();
    server
        .app
        .db
        .tx(|conn| {
            conn.execute(
                "UPDATE documents SET deleted_at = 1 WHERE id = ?1",
                [document_id],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        http.delete(format!("{base}/v1/documents/{document_id}/purge"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server
        .app
        .db
        .read(|conn| {
            let blobs: i64 =
                conn.query_row("SELECT COUNT(*) FROM asset_blobs", [], |row| row.get(0))?;
            assert_eq!(blobs, 0);
            Ok(())
        })
        .unwrap();
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_metadata_transaction_reclaims_unreferenced_published_bytes() {
    let server = TestServer::spawn(temp_db("asset-rollback")).await;
    let http = reqwest::Client::new();
    let owner = create_principal(&server.base, &http, "assetrollbackowner").await;
    let created: Value = http
        .post(format!("{}/v1/documents", server.base))
        .header("Cookie", &owner.cookie)
        .header("Origin", &server.base)
        .json(&json!({ "title": "Rollback" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let document_id = created["document"]["id"].as_str().unwrap();
    server
        .app
        .db
        .tx(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_asset_metadata
                 BEFORE INSERT ON document_assets
                 BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END;",
            )?;
            Ok(())
        })
        .unwrap();

    let bytes = png(42);
    let path = stored_path(server.app.assets.root(), &bytes);
    let response = http
        .post(format!("{}/v1/documents/{document_id}/assets", server.base))
        .header("Cookie", &owner.cookie)
        .header("Origin", &server.base)
        .header("x-marks-filename", "rollback.png")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    assert!(
        !path.exists(),
        "failed metadata must not leak published bytes"
    );
    server.stop().await;
}
