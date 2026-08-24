//! Production-contract coverage for the session-owned hosted-agent gateway.
//! The provider is deterministic, but every HTTP, auth, SQLite, SSE, replay,
//! cancellation, and restart boundary is the same one used in production.

mod common;

use async_trait::async_trait;
use common::{Principal, TestServer, create_principal, now_ms, temp_db};
use futures_util::StreamExt;
use marks_server::agent::protocol::{AgentUsage, ToolResultStatus};
use marks_server::agent::{
    AgentDriver, AgentProvider, ProviderCompletion, ProviderError, ProviderRequest,
    ProviderToolCall, ProviderToolResult,
};
use rusqlite::params;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct ScriptedProvider {
    call_tool: bool,
    runs: AtomicUsize,
    requests: Mutex<Vec<ProviderRequest>>,
    results: Mutex<Vec<ProviderToolResult>>,
}

impl ScriptedProvider {
    fn text_only() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn with_tool() -> Arc<Self> {
        Arc::new(Self {
            call_tool: true,
            ..Self::default()
        })
    }
}

#[async_trait]
impl AgentProvider for ScriptedProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    async fn run(
        &self,
        request: ProviderRequest,
        driver: AgentDriver,
    ) -> Result<ProviderCompletion, ProviderError> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(request.clone());
        driver.emit_text("Planning. ")?;
        if self.call_tool {
            let result = driver
                .call_tool(ProviderToolCall {
                    call_id: "call_preview_1".to_owned(),
                    name: "marks_view_preview".to_owned(),
                    arguments: json!({}),
                })
                .await?;
            self.results.lock().unwrap().push(result);
            driver.emit_text("Applied.")?;
        } else {
            driver.emit_text("Done.")?;
        }
        Ok(ProviderCompletion {
            usage: AgentUsage {
                input_tokens: 7,
                output_tokens: 3,
                total_tokens: 10,
            },
        })
    }
}

fn run_body(request_id: &str, document_id: &str, prompt: &str) -> Value {
    json!({
        "requestId": request_id,
        "documentId": document_id,
        "prompt": prompt,
        "tools": [{
            "commandId": "view.preview",
            "name": "marks_view_preview",
            "description": "Show the rendered Markdown preview",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            },
            "effect": "read",
            "durability": "ephemeral"
        }]
    })
}

async fn create_document(
    base: &str,
    http: &reqwest::Client,
    principal: &Principal,
    markdown: &str,
) -> String {
    let response = http
        .post(format!("{base}/v1/documents"))
        .header("Cookie", &principal.cookie)
        .header("Origin", base)
        .json(&json!({ "title": "Agent contract", "markdown": markdown }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    response.json::<Value>().await.unwrap()["document"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn create_run(
    base: &str,
    http: &reqwest::Client,
    principal: &Principal,
    body: &Value,
) -> reqwest::Response {
    http.post(format!("{base}/v1/agent/runs"))
        .header("Cookie", &principal.cookie)
        .header("Origin", base)
        .header("X-Marks-CSRF", &principal.csrf)
        .json(body)
        .send()
        .await
        .unwrap()
}

#[derive(Debug)]
struct SseEvent {
    id: u64,
    kind: String,
    data: Value,
}

async fn collect_sse(
    response: reqwest::Response,
    tool_calls: Option<tokio::sync::mpsc::UnboundedSender<Value>>,
) -> Vec<SseEvent> {
    assert_eq!(response.status(), 200);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"))
    );
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    let mut events = Vec::new();
    while let Some(chunk) = stream.next().await {
        buffer.extend_from_slice(&chunk.unwrap());
        while let Some((position, separator)) = frame_boundary(&buffer) {
            let tail = buffer.split_off(position + separator);
            let frame = std::mem::replace(&mut buffer, tail);
            if let Some(event) = parse_sse_frame(&frame[..position]) {
                if event.kind == "tool.call"
                    && let Some(sender) = &tool_calls
                {
                    let _ = sender.send(event.data.clone());
                }
                events.push(event);
            }
        }
    }
    events
}

fn frame_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|window| window == b"\n\n");
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(position), None) => Some((position, 2)),
        (None, Some(position)) => Some((position, 4)),
        (None, None) => None,
    }
}

fn parse_sse_frame(frame: &[u8]) -> Option<SseEvent> {
    let text = std::str::from_utf8(frame).unwrap();
    let mut id = None;
    let mut kind = None;
    let mut data = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("id:") {
            id = Some(value.trim().parse::<u64>().unwrap());
        } else if let Some(value) = line.strip_prefix("event:") {
            kind = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    let (Some(id), Some(kind)) = (id, kind) else {
        return None;
    };
    Some(SseEvent {
        id,
        kind,
        data: serde_json::from_str(&data.join("\n")).unwrap(),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn hosted_run_is_authorized_idempotent_replayable_and_restart_durable() {
    let provider = ScriptedProvider::text_only();
    let server = TestServer::spawn_with_provider(
        temp_db("agent-idempotency"),
        |_| {},
        Some(provider.clone()),
    )
    .await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "agent-owner").await;
    let stranger = create_principal(&base, &http, "agent-stranger").await;
    let document_id = create_document(
        &base,
        &http,
        &owner,
        "# Private\n\nNEVER_SENT_DOCUMENT_MARKER\n",
    )
    .await;

    let capabilities: Value = http
        .get(format!("{base}/v1/agent/capabilities"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(capabilities["enabled"], true);
    assert_eq!(capabilities["provider"], "openai");
    assert_eq!(capabilities["protocolVersion"], 1);

    let body = run_body("request_idempotent_1", &document_id, "Show rendered view");
    assert_eq!(
        http.post(format!("{base}/v1/agent/runs"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        403,
        "a same-origin mutation still requires CSRF"
    );
    assert_eq!(
        create_run(&base, &http, &stranger, &body).await.status(),
        404,
        "an unreadable document is indistinguishable from absence"
    );

    let accepted = create_run(&base, &http, &owner, &body).await;
    assert_eq!(accepted.status(), 202);
    let accepted: Value = accepted.json().await.unwrap();
    let run_id = accepted["runId"].as_str().unwrap().to_owned();
    assert_eq!(accepted["replayed"], false);

    let events = collect_sse(
        http.get(format!("{base}/v1/agent/runs/{run_id}/events"))
            .header("Cookie", &owner.cookie)
            .send()
            .await
            .unwrap(),
        None,
    )
    .await;
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        [
            "run.started",
            "assistant.delta",
            "assistant.delta",
            "run.completed"
        ]
    );
    assert!(events.windows(2).all(|pair| pair[0].id < pair[1].id));
    assert_eq!(events.last().unwrap().data["usage"]["totalTokens"], 10);

    // Scoped so the guard provably ends before the next await point;
    // clippy's await_holding_lock does not credit an explicit drop().
    {
        let seen = provider.requests.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].prompt, "Show rendered view");
        assert!(!format!("{:?}", seen[0]).contains("NEVER_SENT_DOCUMENT_MARKER"));
        assert_ne!(seen[0].safety_identifier, owner.principal_id);
        assert_eq!(seen[0].safety_identifier.len(), 64);
    }

    let replay = create_run(&base, &http, &owner, &body).await;
    assert_eq!(replay.status(), 200);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["runId"], run_id);
    assert_eq!(replay["replayed"], true);
    assert_eq!(provider.runs.load(Ordering::SeqCst), 1);

    let changed = run_body(
        "request_idempotent_1",
        &document_id,
        "A different instruction under the same key",
    );
    assert_eq!(
        create_run(&base, &http, &owner, &changed).await.status(),
        409
    );
    assert_eq!(
        http.get(format!("{base}/v1/agent/runs/{run_id}/events"))
            .header("Cookie", &stranger.cookie)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );

    let db_path = server.stop().await;
    let restarted = TestServer::spawn(db_path).await;
    let replayed_after_restart = collect_sse(
        http.get(format!(
            "{}/v1/agent/runs/{run_id}/events?after=2",
            restarted.base
        ))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap(),
        None,
    )
    .await;
    assert_eq!(
        replayed_after_restart
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        ["assistant.delta", "run.completed"]
    );
    restarted.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_receipts_are_serialized_idempotent_bounded_and_cancellable() {
    let provider = ScriptedProvider::with_tool();
    let server = TestServer::spawn_with_provider(
        temp_db("agent-tool-receipts"),
        |config| config.agent.max_concurrent_runs_per_session = 1,
        Some(provider.clone()),
    )
    .await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "agent-tools").await;
    let document_id = create_document(&base, &http, &owner, "# Tools\n").await;
    let body = run_body("request_tool_1", &document_id, "Show rendered view");
    let accepted: Value = create_run(&base, &http, &owner, &body)
        .await
        .json()
        .await
        .unwrap();
    let run_id = accepted["runId"].as_str().unwrap().to_owned();

    let second = run_body("request_tool_2", &document_id, "Show it again");
    assert_eq!(
        create_run(&base, &http, &owner, &second).await.status(),
        429,
        "one waiting tool call consumes the configured session admission slot"
    );

    let (tool_tx, mut tool_rx) = tokio::sync::mpsc::unbounded_channel();
    let stream_http = http.clone();
    let stream_base = base.clone();
    let stream_cookie = owner.cookie.clone();
    let stream_run = run_id.clone();
    let stream_task = tokio::spawn(async move {
        collect_sse(
            stream_http
                .get(format!("{stream_base}/v1/agent/runs/{stream_run}/events"))
                .header("Cookie", stream_cookie)
                .send()
                .await
                .unwrap(),
            Some(tool_tx),
        )
        .await
    });
    let call = tokio::time::timeout(Duration::from_secs(5), tool_rx.recv())
        .await
        .expect("tool call event timeout")
        .expect("tool call event");
    assert_eq!(call["callId"], "call_preview_1");
    assert_eq!(call["commandId"], "view.preview");

    let result = json!({
        "requestId": "result_request_1",
        "callId": "call_preview_1",
        "status": "succeeded",
        "output": { "commandId": "view.preview", "message": "Preview visible" }
    });
    assert_eq!(
        http.post(format!("{base}/v1/agent/runs/{run_id}/tool-results"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .json(&result)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let submitted = http
        .post(format!("{base}/v1/agent/runs/{run_id}/tool-results"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .json(&result)
        .send()
        .await
        .unwrap();
    assert_eq!(submitted.status(), 200);
    assert_eq!(submitted.json::<Value>().await.unwrap()["replayed"], false);

    let replayed = http
        .post(format!("{base}/v1/agent/runs/{run_id}/tool-results"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .json(&result)
        .send()
        .await
        .unwrap();
    assert_eq!(replayed.status(), 200);
    assert_eq!(replayed.json::<Value>().await.unwrap()["replayed"], true);

    let conflict = json!({
        "requestId": "result_request_1",
        "callId": "call_preview_1",
        "status": "failed",
        "output": { "commandId": "view.preview", "error": "changed" }
    });
    assert_eq!(
        http.post(format!("{base}/v1/agent/runs/{run_id}/tool-results"))
            .header("Cookie", &owner.cookie)
            .header("Origin", &base)
            .header("X-Marks-CSRF", &owner.csrf)
            .json(&conflict)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );

    let events = tokio::time::timeout(Duration::from_secs(5), stream_task)
        .await
        .expect("terminal event timeout")
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == "tool.result.accepted")
    );
    assert_eq!(events.last().unwrap().kind, "run.completed");
    // Scoped so the guard provably ends before the next await point;
    // clippy's await_holding_lock does not credit an explicit drop().
    {
        let results = provider.results.lock().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, ToolResultStatus::Succeeded);
    }

    let cancel_body = run_body("request_cancel_1", &document_id, "Show preview then wait");
    let cancel_run: Value = create_run(&base, &http, &owner, &cancel_body)
        .await
        .json()
        .await
        .unwrap();
    let cancel_id = cancel_run["runId"].as_str().unwrap();
    let cancelled = http
        .delete(format!("{base}/v1/agent/runs/{cancel_id}"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(cancelled.status(), 200);
    assert_eq!(cancelled.json::<Value>().await.unwrap()["replayed"], false);
    let cancelled_again = http
        .delete(format!("{base}/v1/agent/runs/{cancel_id}"))
        .header("Cookie", &owner.cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &owner.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(cancelled_again.status(), 200);
    let cancelled_again = cancelled_again.json::<Value>().await.unwrap();
    assert_eq!(cancelled_again["status"], "cancelled");
    assert_eq!(cancelled_again["replayed"], true);
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_converts_interrupted_runs_into_durable_terminal_receipts() {
    let server = TestServer::spawn(temp_db("agent-restart-recovery")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let owner = create_principal(&base, &http, "agent-recovery").await;
    let document_id = create_document(&base, &http, &owner, "# Recovery\n").await;
    let session: Value = http
        .get(format!("{base}/v1/auth/session"))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    let db_path = server.stop().await;

    let now = now_ms();
    let connection = rusqlite::Connection::open(&db_path).unwrap();
    connection
        .execute(
            "INSERT INTO agent_runs
                (id, session_id, principal_id, document_id, request_id, request_hash,
                 provider, status, created_at, updated_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'openai', 'running', ?7, ?7, ?8)",
            params![
                "run_interrupted_1",
                session_id,
                owner.principal_id,
                document_id,
                "request_interrupted_1",
                vec![9_u8; 32],
                i64::try_from(now).unwrap(),
                i64::try_from(now + 600_000).unwrap(),
            ],
        )
        .unwrap();
    let started = json!({
        "runId": "run_interrupted_1",
        "documentId": document_id,
        "status": "running",
        "createdAtMs": now,
    })
    .to_string();
    connection
        .execute(
            "INSERT INTO agent_events (run_id, sequence, kind, data_json, bytes, created_at)
             VALUES ('run_interrupted_1', 1, 'run.started', ?1, ?2, ?3)",
            params![
                started,
                i64::try_from(started.len()).unwrap(),
                i64::try_from(now).unwrap()
            ],
        )
        .unwrap();
    drop(connection);

    let restarted = TestServer::spawn(db_path).await;
    let events = collect_sse(
        http.get(format!(
            "{}/v1/agent/runs/run_interrupted_1/events",
            restarted.base
        ))
        .header("Cookie", &owner.cookie)
        .send()
        .await
        .unwrap(),
        None,
    )
    .await;
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        ["run.started", "run.failed"]
    );
    assert_eq!(events.last().unwrap().data["code"], "serverRestart");
    restarted.stop().await;
}
