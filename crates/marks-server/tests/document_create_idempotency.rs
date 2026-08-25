mod common;

use common::{TestServer, temp_db};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

#[tokio::test(flavor = "multi_thread")]
async fn lost_create_response_replays_one_slug_after_restart_and_rebinding_conflicts() {
    let db_path = temp_db("document-create-idempotency");
    let first = TestServer::spawn(db_path.clone()).await;
    let http = reqwest::Client::new();
    let scratch: Value = http
        .post(format!("{}/v1/auth/scratch", first.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let authority = format!(
        "MarksScratch {}.{}",
        scratch["scratchId"].as_str().unwrap(),
        scratch["capability"].as_str().unwrap()
    );
    let request_id = "11111111-1111-4111-8111-111111111111";
    let body = serde_json::to_vec(&json!({
        "title": "Welcome to Marks",
        "markdown": "# One public starter\n",
        "requestId": request_id,
    }))
    .unwrap();

    // Send the complete request, then deliberately never read its response.
    // Poll the durable receipt before dropping the socket to prove the exact
    // commit-succeeded/response-lost condition rather than a cancelled POST.
    let mut socket = TcpStream::connect(first.addr).await.unwrap();
    let head = format!(
        "POST /v1/documents HTTP/1.1\r\nHost: {}\r\nAuthorization: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        first.addr,
        authority,
        body.len(),
    );
    socket.write_all(head.as_bytes()).await.unwrap();
    socket.write_all(&body).await.unwrap();
    socket.flush().await.unwrap();

    let document_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Some(id) = first
                .app
                .db
                .read(|connection| {
                    Ok(connection
                        .query_row(
                            "SELECT id FROM documents WHERE create_request_id = ?1",
                            [request_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok())
                })
                .unwrap()
            {
                break id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("server commits before the client abandons its response");
    drop(socket);
    first.stop().await;

    let second = TestServer::spawn(db_path).await;
    let replay = http
        .post(format!("{}/v1/documents", second.base))
        .header("Authorization", &authority)
        .json(&json!({
            "title": "Welcome to Marks",
            "markdown": "# One public starter\n",
            "requestId": request_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 200);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["document"]["id"], document_id);
    assert_eq!(replay["replayed"], true);

    let catalog: Value = http
        .get(format!("{}/v1/documents", second.base))
        .header("Authorization", &authority)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["documents"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["documents"][0]["id"], document_id);

    let conflict = http
        .post(format!("{}/v1/documents", second.base))
        .header("Authorization", &authority)
        .json(&json!({
            "title": "Welcome to Marks",
            "markdown": "# Rebound payload\n",
            "requestId": request_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), 409);
    second.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_retries_return_one_copy_after_restart() {
    let db_path = temp_db("document-duplicate-idempotency");
    let first = TestServer::spawn(db_path.clone()).await;
    let http = reqwest::Client::new();
    let scratch: Value = http
        .post(format!("{}/v1/auth/scratch", first.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let authority = format!(
        "MarksScratch {}.{}",
        scratch["scratchId"].as_str().unwrap(),
        scratch["capability"].as_str().unwrap()
    );
    let source: Value = http
        .post(format!("{}/v1/documents", first.base))
        .header("Authorization", &authority)
        .json(&json!({ "title": "Source", "markdown": "# Source\n" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let source_id = source["document"]["id"].as_str().unwrap();
    let request_id = "55555555-5555-4555-8555-555555555555";
    let duplicated = http
        .post(format!("{}/v1/documents/{source_id}/duplicate", first.base))
        .header("Authorization", &authority)
        .json(&json!({ "requestId": request_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicated.status(), 201);
    let duplicated: Value = duplicated.json().await.unwrap();
    let duplicate_id = duplicated["document"]["id"].as_str().unwrap().to_owned();
    first.stop().await;

    let second = TestServer::spawn(db_path).await;
    let replay = http
        .post(format!(
            "{}/v1/documents/{source_id}/duplicate",
            second.base
        ))
        .header("Authorization", &authority)
        .json(&json!({ "requestId": request_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 200);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["document"]["id"], duplicate_id);
    assert_eq!(replay["replayed"], true);

    let catalog: Value = http
        .get(format!("{}/v1/documents", second.base))
        .header("Authorization", &authority)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["documents"].as_array().unwrap().len(), 2);
    second.stop().await;
}
