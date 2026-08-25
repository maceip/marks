mod common;

use common::{DeviceKey, TestServer, b64, cookie_value, create_principal, now_ms, temp_db};
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

#[tokio::test(flavor = "multi_thread")]
async fn scratch_trash_and_reserved_site_follow_login_for_restore_and_purge() {
    let server = TestServer::spawn(temp_db("scratch-trash-promotion")).await;
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
    let scratch_id = scratch["scratchId"].as_str().unwrap().to_owned();
    let scratch_auth = format!(
        "MarksScratch {scratch_id}.{}",
        scratch["capability"].as_str().unwrap()
    );
    let device_key = DeviceKey::generate();
    let device_id = "device_scratch_trash_login";
    assert_eq!(
        http.put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
            .header("Authorization", &scratch_auth)
            .json(&json!({
                "deviceId": device_id,
                "publicKey": b64(&device_key.public_sec1()),
            }))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );

    let created: Value = http
        .post(format!("{base}/v1/documents"))
        .header("Authorization", &scratch_auth)
        .json(&json!({ "title": "Scratch trash", "markdown": "# Keep me\n" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();

    // Reserve a real replica site before deletion. Promotion must transfer it
    // along with the tombstone instead of leaving stale scratch ownership.
    let ticket: Value = http
        .post(format!("{base}/v1/scratch/documents/{document_id}/session"))
        .header("Authorization", &scratch_auth)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let site_id = ticket["siteId"].as_str().unwrap().to_owned();
    assert_eq!(
        http.delete(format!("{base}/v1/documents/{document_id}"))
            .header("Authorization", &scratch_auth)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let before_login: Value = http
        .get(format!("{base}/v1/trash"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(before_login["documents"][0]["id"], document_id);

    let now = now_ms();
    let bootstrap = marks_auth::SelfBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_scratch_trash_login").unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        device_id: marks_auth::DeviceId::new(device_id).unwrap(),
        device_public_key_hash: device_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let promoted = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&json!({
            "bootstrap": {
                "version": 1,
                "controllerId": bootstrap.controller_id.as_str(),
                "scratchId": scratch_id,
                "deviceId": device_id,
                "devicePublicKeyHash": b64(&bootstrap.device_public_key_hash),
                "issuedAtMs": now,
                "expiresAtMs": now + 60_000,
            },
            "signature": b64(&device_key.sign_p1363(&bootstrap.signing_bytes())),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(promoted.status(), 201);
    let cookie = cookie_value(
        promoted
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );
    let promoted: Value = promoted.json().await.unwrap();
    let principal_id = promoted["principalId"].as_str().unwrap().to_owned();

    // The ownership graph changes in the same promotion transaction while the
    // deleted bit remains intact.
    server
        .app
        .db
        .read(|connection| {
            let document: (Option<String>, Option<String>, Option<i64>) = connection.query_row(
                "SELECT scratch_id, owner_principal_id, deleted_at
                 FROM documents WHERE id = ?1",
                [&document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(document.0, None);
            assert_eq!(document.1.as_deref(), Some(principal_id.as_str()));
            assert!(document.2.is_some());

            let owner_role: String = connection.query_row(
                "SELECT role FROM document_acl
                 WHERE document_id = ?1 AND principal_id = ?2 AND revoked_at IS NULL",
                [&document_id, &principal_id],
                |row| row.get(0),
            )?;
            assert_eq!(owner_role, "owner");

            let site: (String, Option<String>, Option<String>, Option<String>) = connection
                .query_row(
                    "SELECT authority_kind, scratch_id, principal_id, device_id
                     FROM document_sites WHERE document_id = ?1 AND site_id = ?2",
                    rusqlite::params![document_id, site_id.parse::<i64>().unwrap()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
            assert_eq!(site.0, "principal");
            assert_eq!(site.1, None);
            assert_eq!(site.2.as_deref(), Some(principal_id.as_str()));
            assert_eq!(site.3.as_deref(), Some(device_id));
            Ok(())
        })
        .unwrap();

    assert_eq!(
        http.get(format!("{base}/v1/trash"))
            .header("Authorization", &scratch_auth)
            .send()
            .await
            .unwrap()
            .status(),
        401,
        "the promoted scratch authority is no longer live"
    );
    let after_login: Value = http
        .get(format!("{base}/v1/trash"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after_login["documents"][0]["id"], document_id);

    assert_eq!(
        http.post(format!("{base}/v1/documents/{document_id}/restore"))
            .header("Cookie", &cookie)
            .header("Origin", &base)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let reused: Value = http
        .post(format!("{base}/v1/documents/{document_id}/session"))
        .header("Cookie", &cookie)
        .header("Origin", &base)
        .json(&json!({ "siteId": site_id }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reused["siteId"], site_id);

    assert_eq!(
        http.delete(format!("{base}/v1/documents/{document_id}"))
            .header("Cookie", &cookie)
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
        .tx(|connection| {
            connection.execute(
                "UPDATE documents SET deleted_at = 1 WHERE id = ?1",
                [&document_id],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        http.delete(format!("{base}/v1/documents/{document_id}/purge"))
            .header("Cookie", &cookie)
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
        .read(|connection| {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
                [&document_id],
                |row| row.get(0),
            )?;
            assert!(!exists);
            Ok(())
        })
        .unwrap();

    server.stop().await;
}
