mod common;

use base64ct::{Base64UrlUnpadded, Encoding};
use common::{TestServer, create_principal, temp_db};
use rusqlite::Connection;
use serde_json::{Value, json};

async fn json_of(response: reqwest::Response) -> Value {
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "status {status}: {body}");
    body
}

#[tokio::test(flavor = "multi_thread")]
async fn initial_markdown_and_review_metadata_are_atomic_bounded_and_role_checked() {
    let server = TestServer::spawn(temp_db("review-plane")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "reviewowner").await;
    let commenter = create_principal(&base, &http, "reviewcommenter").await;
    let viewer = create_principal(&base, &http, "reviewviewer").await;
    let markdown = "# Product brief\n\nAtomic template body. 🦀\n";

    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&json!({ "title": "Brief", "markdown": markdown }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap();
    assert_eq!(
        created["document"]["chars"].as_u64(),
        Some(markdown.encode_utf16().count() as u64)
    );
    let exported = http
        .get(format!("{base}/v1/documents/{document_id}/export"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(exported.status(), 200);
    assert_eq!(exported.text().await.unwrap(), markdown);

    // Initial metadata and CRDT state were one SQLite publication, including
    // authorship for every operation produced by the template insertion.
    server
        .app
        .db
        .read(|conn| {
            let (snapshot_bytes, authors): (i64, i64) = conn.query_row(
                "SELECT length(snapshot),
                    (SELECT COUNT(*) FROM op_authors WHERE document_id = d.id)
             FROM documents d WHERE id = ?1",
                [document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert!(snapshot_bytes > 0);
            assert_eq!(authors as usize, markdown.encode_utf16().count());
            Ok(())
        })
        .unwrap();

    for (principal, role) in [(&commenter, "commenter"), (&viewer, "viewer")] {
        let response = http
            .put(format!(
                "{base}/v1/documents/{document_id}/shares/{}",
                principal.principal_id
            ))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&json!({ "role": role }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }

    let comment = json_of(
        http.post(format!("{base}/v1/documents/{document_id}/comments"))
            .header("Cookie", &commenter.cookie)
            .header("Origin", &base)
            .json(&json!({
                "body": "Please name the proof.",
                "startAnchor": Base64UrlUnpadded::encode_string(&esbt::Anchor::start().encode()),
                "endAnchor": Base64UrlUnpadded::encode_string(&esbt::Anchor::end().encode()),
                "quote": markdown,
                "startOffset": 0,
                "endOffset": markdown.encode_utf16().count(),
            }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let comment_id = comment["comment"]["id"].as_str().unwrap();
    assert_eq!(comment["comment"]["author"], commenter.principal_id);
    assert_eq!(comment["comment"]["quote"], markdown);
    assert_eq!(comment["comment"]["own"], true);

    let reply = json_of(
        http.post(format!(
            "{base}/v1/documents/{document_id}/comments/{comment_id}/replies"
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "body": "The proof is the restart receipt." }))
        .send()
        .await
        .unwrap(),
    )
    .await;
    let reply_id = reply["reply"]["id"].as_str().unwrap();
    assert_eq!(reply["reply"]["own"], true);

    let edited = http
        .put(format!(
            "{base}/v1/documents/{document_id}/comments/{comment_id}/replies/{reply_id}"
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "body": "The proof is the durable restart receipt." }))
        .send()
        .await
        .unwrap();
    assert_eq!(edited.status(), 200);

    let forged_edit = http
        .put(format!(
            "{base}/v1/documents/{document_id}/comments/{comment_id}"
        ))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .json(&json!({ "body": "owner overwrote another author's words" }))
        .send()
        .await
        .unwrap();
    assert_eq!(forged_edit.status(), 403);

    let visible = http
        .get(format!("{base}/v1/documents/{document_id}/comments"))
        .header("Cookie", &viewer.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(visible.status(), 200);
    let visible = visible.json::<Value>().await.unwrap();
    assert_eq!(visible["comments"].as_array().unwrap().len(), 1);
    assert_eq!(
        visible["comments"][0]["replies"][0]["body"],
        "The proof is the durable restart receipt."
    );
    assert_eq!(visible["comments"][0]["own"], false);

    let viewer_comment = http
        .post(format!("{base}/v1/documents/{document_id}/comments"))
        .header("Cookie", &viewer.cookie)
        .header("Origin", &base)
        .json(&json!({ "body": "forged" }))
        .send()
        .await
        .unwrap();
    assert_eq!(viewer_comment.status(), 403);

    let resolved = http
        .put(format!(
            "{base}/v1/documents/{document_id}/comments/{comment_id}"
        ))
        .header("Cookie", &commenter.cookie)
        .header("Origin", &base)
        .json(&json!({ "resolved": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(resolved.status(), 200);

    let commenter_version = http
        .post(format!("{base}/v1/documents/{document_id}/versions"))
        .header("Cookie", &commenter.cookie)
        .header("Origin", &base)
        .json(&json!({ "label": "forged" }))
        .send()
        .await
        .unwrap();
    assert_eq!(commenter_version.status(), 403);

    let mut version_ids = Vec::new();
    for label in ["Ready for review", "Same content, second milestone"] {
        let version = json_of(
            http.post(format!("{base}/v1/documents/{document_id}/versions"))
                .header("Cookie", &owner.cookie)
                .header("Origin", &base)
                .json(&json!({ "label": label }))
                .send()
                .await
                .unwrap(),
        )
        .await;
        version_ids.push(version["version"]["id"].as_str().unwrap().to_owned());
    }

    server
        .app
        .db
        .read(|conn| {
            let blobs: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_version_blobs WHERE document_id = ?1",
                [document_id],
                |row| row.get(0),
            )?;
            assert_eq!(
                blobs, 1,
                "identical Markdown must share one compressed blob"
            );
            Ok(())
        })
        .unwrap();

    let loaded = json_of(
        http.get(format!(
            "{base}/v1/documents/{document_id}/versions/{}",
            version_ids[0]
        ))
        .header("Cookie", &viewer.cookie)
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(loaded["markdown"], markdown);

    for version_id in &version_ids {
        let deleted = http
            .delete(format!(
                "{base}/v1/documents/{document_id}/versions/{version_id}"
            ))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), 200);
    }
    server
        .app
        .db
        .read(|conn| {
            let blobs: i64 = conn.query_row(
                "SELECT COUNT(*) FROM document_version_blobs WHERE document_id = ?1",
                [document_id],
                |row| row.get(0),
            )?;
            assert_eq!(blobs, 0, "last reference deletion must reclaim the blob");
            Ok(())
        })
        .unwrap();

    let db = server.stop().await;
    let conn = Connection::open(db).unwrap();
    let persisted: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM document_comments WHERE document_id = ?1 AND resolved = 1",
            [document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn comment_keyset_cursor_reaches_every_bounded_page_without_duplicates() {
    let server = TestServer::spawn(temp_db("review-pagination")).await;
    let http = reqwest::Client::new();
    let owner = create_principal(&server.base, &http, "reviewpageowner").await;
    let created = json_of(
        http.post(format!("{}/v1/documents", server.base))
            .header("Cookie", &owner.cookie)
            .header("Origin", &server.base)
            .json(&json!({ "title": "Paged review" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap();

    for index in 0..30 {
        let response = http
            .post(format!(
                "{}/v1/documents/{document_id}/comments",
                server.base
            ))
            .header("Cookie", &owner.cookie)
            .header("Origin", &server.base)
            .json(&json!({ "body": format!("thread {index}") }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
    }

    let first = json_of(
        http.get(format!(
            "{}/v1/documents/{document_id}/comments",
            server.base
        ))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(first["comments"].as_array().unwrap().len(), 25);
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["repliesTruncated"], false);
    let cursor = first["nextCursor"].as_str().unwrap();

    let second = json_of(
        http.get(format!(
            "{}/v1/documents/{document_id}/comments?cursor={cursor}",
            server.base
        ))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(second["comments"].as_array().unwrap().len(), 5);
    assert_eq!(second["hasMore"], false);
    assert!(second["nextCursor"].is_null());

    let first_ids = first["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|comment| comment["id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert!(
        second["comments"]
            .as_array()
            .unwrap()
            .iter()
            .all(|comment| !first_ids.contains(comment["id"].as_str().unwrap()))
    );

    let malformed = http
        .get(format!(
            "{}/v1/documents/{document_id}/comments?cursor=not-base64%25",
            server.base
        ))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 400);
    server.stop().await;
}
