mod common;

use common::{TestServer, create_principal, temp_db};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn trash_is_owner_only_restorable_and_retention_gates_atomic_purge() {
    let server = TestServer::spawn(temp_db("document-trash")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "trashowner").await;
    let viewer = create_principal(&base, &http, "trashviewer").await;

    let created: Value = http
        .post(format!("{base}/v1/documents"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "title": "Recover me", "markdown": "# Durable\n" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let document_id = created["document"]["id"].as_str().unwrap();

    assert_eq!(
        http.put(format!(
            "{base}/v1/documents/{document_id}/shares/{}",
            viewer.principal_id
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "role": "viewer" }))
        .send()
        .await
        .unwrap()
        .status(),
        200
    );

    // Seed dependent metadata so physical deletion proves FK-order cleanup,
    // not merely removal of an otherwise empty catalog row.
    assert_eq!(
        http.post(format!("{base}/v1/documents/{document_id}/comments"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&json!({ "body": "Keep this context" }))
            .send()
            .await
            .unwrap()
            .status(),
        201
    );
    assert_eq!(
        http.post(format!("{base}/v1/documents/{document_id}/versions"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&json!({ "label": "Before trash" }))
            .send()
            .await
            .unwrap()
            .status(),
        201
    );

    assert_eq!(
        http.delete(format!("{base}/v1/documents/{document_id}"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        http.get(format!("{base}/v1/documents/{document_id}"))
            .header("Cookie", &owner.cookie)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );

    let owner_trash: Value = http
        .get(format!("{base}/v1/trash"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(owner_trash["documents"].as_array().unwrap().len(), 1);
    assert!(
        owner_trash["documents"][0]["purge_at"].as_u64().unwrap()
            > owner_trash["documents"][0]["deleted_at"].as_u64().unwrap()
    );

    let viewer_trash: Value = http
        .get(format!("{base}/v1/trash"))
        .header("Cookie", &viewer.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(viewer_trash["documents"].as_array().unwrap().is_empty());

    assert_eq!(
        http.delete(format!("{base}/v1/documents/{document_id}/purge"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );

    let restored: Value = http
        .post(format!("{base}/v1/documents/{document_id}/restore"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(restored["document"]["deleted_at"], Value::Null);
    assert_eq!(
        http.get(format!("{base}/v1/documents/{document_id}"))
            .header("Cookie", &owner.cookie)
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
            for (table, column) in [
                ("documents", "id"),
                ("document_comments", "document_id"),
                ("document_versions", "document_id"),
                ("document_version_blobs", "document_id"),
                ("document_acl", "document_id"),
            ] {
                let count: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
                    [document_id],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0, "{table} was not reclaimed");
            }
            Ok(())
        })
        .unwrap();

    server.stop().await;
}
