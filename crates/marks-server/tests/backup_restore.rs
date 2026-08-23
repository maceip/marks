mod common;

use common::{TestServer, temp_db};
use serde_json::{Value, json};

fn png() -> Vec<u8> {
    b"\x89PNG\r\n\x1a\nbackup-proof".to_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn verified_backup_restores_database_authority_and_asset_bytes() {
    let db = temp_db("backup-source");
    let server = TestServer::spawn(db.clone()).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let scratch: Value = http
        .post(format!("{base}/v1/auth/scratch"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let auth = format!(
        "MarksScratch {}.{}",
        scratch["scratchId"].as_str().unwrap(),
        scratch["capability"].as_str().unwrap()
    );
    let created: Value = http
        .post(format!("{base}/v1/documents"))
        .header("Authorization", &auth)
        .json(&json!({ "title": "Restored" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();
    let uploaded: Value = http
        .post(format!("{base}/v1/documents/{document_id}/assets"))
        .header("Authorization", &auth)
        .header("x-marks-filename", "proof.png")
        .body(png())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let asset_id = uploaded["asset"]["id"].as_str().unwrap().to_owned();
    let asset_url = uploaded["asset"]["url"].as_str().unwrap();
    let markdown = format!("# Backup proof\n\n![proof]({asset_url})\n");
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
        .tx(|connection| {
            connection.execute(
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

    let backup_root = db.with_extension("backups");
    let published = marks_server::backup::create_once(
        server.app.db.clone(),
        server.app.assets.clone(),
        backup_root.clone(),
        server.app.artifact.clone(),
    )
    .await
    .expect("create verified backup");
    let manifest = marks_server::backup::verify(published.clone())
        .await
        .expect("verify published backup");
    assert_eq!(manifest.schema, "marks-backup.v1");
    assert_eq!(manifest.assets.len(), 1);

    server.stop().await;
    let restored_db = db.with_extension("restored.db3");
    let restored_assets = db.with_extension("restored-assets");
    marks_server::backup::restore(published, restored_db.clone(), restored_assets.clone())
        .await
        .expect("restore into empty destinations");
    assert!(
        marks_server::backup::restore(
            backup_root.join("missing"),
            restored_db.clone(),
            restored_assets.clone(),
        )
        .await
        .unwrap_err()
        .contains("must not already exist"),
        "restore refuses overwrite before reading an untrusted source"
    );

    let restored = TestServer::spawn_with(restored_db, |config| {
        config.asset_dir = restored_assets.clone();
    })
    .await;
    let exported = http
        .get(format!(
            "{}/v1/documents/{document_id}/export",
            restored.base
        ))
        .header("Authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(exported.status(), 200);
    assert_eq!(exported.text().await.unwrap(), markdown);
    let image = http
        .get(format!("{}/a/{document_id}/{asset_id}", restored.base))
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), 200);
    assert_eq!(image.bytes().await.unwrap().as_ref(), png());
    restored.stop().await;
    let _ = std::fs::remove_dir_all(backup_root);
}
