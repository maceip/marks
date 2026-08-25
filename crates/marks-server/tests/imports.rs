//! HTTP-level proof for the import boundary: caller authorization, a real
//! formula-bearing workbook, atomic publication, and URL SSRF refusal.

mod common;

use common::{TestServer, temp_db};
use office_oxide::xlsx::write::{CellData, XlsxWriter};
use serde_json::{Value, json};
use std::io::Cursor;
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn scratch_authority(base: &str, http: &reqwest::Client) -> String {
    let scratch: Value = http
        .post(format!("{base}/v1/auth/scratch"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    format!(
        "MarksScratch {}.{}",
        scratch["scratchId"].as_str().unwrap(),
        scratch["capability"].as_str().unwrap()
    )
}

fn formula_workbook() -> Vec<u8> {
    let mut workbook = XlsxWriter::new();
    let mut sheet = workbook.add_sheet("Sales");
    sheet.set_cell(0, 0, CellData::String("Item".into()));
    sheet.set_cell(0, 1, CellData::String("Amount".into()));
    sheet.set_cell(1, 0, CellData::String("Widget".into()));
    sheet.set_cell(1, 1, CellData::Number(1500.0));
    sheet.set_cell(2, 0, CellData::String("Total".into()));
    sheet.set_cell(2, 1, CellData::Formula("SUM(B2:B2)".into()));
    let mut bytes = Cursor::new(Vec::new());
    workbook.write_to(&mut bytes).unwrap();
    bytes.into_inner()
}

async fn partial_import(addr: SocketAddr, authority: Option<&str>) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let authorization = authority
        .map(|authority| format!("Authorization: {authority}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "POST /v1/import/file HTTP/1.1\r\nHost: {addr}\r\n{authorization}X-Marks-Filename: held.pdf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        marks_server::routes::imports::MAX_IMPORT_BYTES
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    stream
}

async fn response_head(stream: &mut TcpStream) -> String {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut response = Vec::new();
        let mut buffer = [0_u8; 512];
        while !response.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).await.unwrap();
            assert_ne!(read, 0, "server closed before returning an HTTP response");
            response.extend_from_slice(&buffer[..read]);
        }
        String::from_utf8(response).unwrap()
    })
    .await
    .expect("response must not wait for the request body")
}

#[tokio::test(flavor = "multi_thread")]
async fn import_authentication_and_capacity_happen_before_body_upload() {
    let server = TestServer::spawn(temp_db("imports-prebody-admission")).await;
    let http = reqwest::Client::new();
    let authority = scratch_authority(&server.base, &http).await;

    let mut unauthenticated = partial_import(server.addr, None).await;
    let response = response_head(&mut unauthenticated).await;
    assert!(response.starts_with("HTTP/1.1 401"), "{response}");

    // Four admitted requests deliberately stop after their headers. The fifth
    // is rejected immediately instead of joining an unbounded semaphore wait
    // or requiring any body bytes to arrive.
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(partial_import(server.addr, Some(&authority)).await);
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let mut overflow = partial_import(server.addr, Some(&authority)).await;
    let response = response_head(&mut overflow).await;
    assert!(response.starts_with("HTTP/1.1 503"), "{response}");

    drop(held);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn imported_excel_is_table_only_and_publishes_as_one_public_document() {
    let server = TestServer::spawn(temp_db("imports-xlsx")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let authority = scratch_authority(&base, &http).await;

    let unauthenticated = http
        .post(format!("{base}/v1/import/file"))
        .header("X-Marks-Filename", "sales.xlsx")
        .body(formula_workbook())
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);

    let response = http
        .post(format!("{base}/v1/import/file"))
        .header("Authorization", &authority)
        .header("X-Marks-Filename", "sales.xlsx")
        .body(formula_workbook())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let imported: Value = response.json().await.unwrap();
    let markdown = imported["markdown"].as_str().unwrap();
    assert_eq!(imported["kind"], "excel");
    assert!(markdown.contains("| Item | Amount |"));
    assert!(markdown.contains("| Widget | 1500 |"));
    assert!(!markdown.contains("SUM("));

    let created = http
        .post(format!("{base}/v1/documents"))
        .header("Authorization", &authority)
        .json(&json!({
            "title": imported["title"],
            "markdown": markdown,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.unwrap();
    assert_eq!(created["document"]["public"], true);
    assert_eq!(created["document"]["public_role"], "editor");
    assert_eq!(created["document"]["slug"], created["document"]["id"]);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn url_import_refuses_a_local_service_before_fetching_it() {
    let server = TestServer::spawn(temp_db("imports-url-ssrf")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let authority = scratch_authority(&base, &http).await;

    let response = http
        .post(format!("{base}/v1/import/url"))
        .header("Authorization", &authority)
        .json(&json!({ "url": format!("{base}/internal") }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);

    server.stop().await;
}
