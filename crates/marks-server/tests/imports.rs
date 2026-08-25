//! HTTP-level proof for the import boundary: caller authorization, a real
//! formula-bearing workbook, atomic publication, and URL SSRF refusal.

mod common;

use common::{TestServer, temp_db};
use office_oxide::xlsx::write::{CellData, XlsxWriter};
use serde_json::{Value, json};
use std::io::Cursor;

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
