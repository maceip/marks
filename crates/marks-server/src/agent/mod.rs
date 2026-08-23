//! Session-owned agent runs with one provider-neutral execution path.
//!
//! Browser requests declare only a prompt and bounded command metadata. The
//! deployment owns the provider, model, endpoint, and credential. Every
//! presentation event is journaled with a monotonic sequence for exact SSE
//! replay; tool results and terminal receipts are exactly idempotent.

pub mod openai;
pub mod protocol;
pub mod provider;

pub use provider::{
    AgentProvider, ProviderCompletion, ProviderError, ProviderRequest, ProviderToolCall,
    ProviderToolResult,
};

use crate::config::{AgentConfig, AgentProviderKind};
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::ids::{new_id, now_ms};
use protocol::{
    AgentEvent, AgentTool, AgentUsage, CancelResponse, Capabilities, CapabilityFeatures,
    CapabilityLimits, CreateRunBody, MAX_ASSISTANT_OUTPUT_BYTES, MAX_EVENT_BYTES, MAX_EVENTS,
    MAX_PROMPT_BYTES, MAX_RUN_EVENT_BYTES, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES,
    MAX_TOOL_CALLS, MAX_TOOL_DESCRIPTION_BYTES, MAX_TOOL_RESULT_BYTES, MAX_TOOLS, PROTOCOL_VERSION,
    RunResponse, RunStatus, ToolResultBody, ToolResultResponse,
};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const ONE_HOUR_MS: u64 = 60 * 60 * 1_000;
const ONE_DAY_MS: u64 = 24 * ONE_HOUR_MS;

pub struct AgentHub {
    db: Arc<Db>,
    config: AgentConfig,
    provider: Option<Arc<dyn AgentProvider>>,
    runs: Mutex<HashMap<String, Arc<RunState>>>,
    admission: Arc<Semaphore>,
    shutdown: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

pub(crate) struct RunState {
    id: String,
    session_id: String,
    principal_id: String,
    document_id: String,
    created_at_ms: u64,
    expires_at_ms: u64,
    cancel: CancellationToken,
    notify: Notify,
    inner: Mutex<RunInner>,
}

struct RunInner {
    status: RunStatus,
    events: Vec<AgentEvent>,
    event_bytes: usize,
    output_text: String,
    usage: AgentUsage,
    pending_tool: Option<PendingTool>,
}

struct PendingTool {
    call_id: String,
    result: Option<ProviderToolResult>,
}

#[derive(Clone)]
pub struct AgentDriver {
    hub: Arc<AgentHub>,
    run: Arc<RunState>,
    tools: Arc<Vec<AgentTool>>,
    tool_calls: Arc<std::sync::atomic::AtomicUsize>,
}

enum CreateTransaction {
    Existing { run_id: String },
    Created,
}

impl AgentHub {
    pub fn new(
        db: Arc<Db>,
        config: AgentConfig,
        injected_provider: Option<Arc<dyn AgentProvider>>,
    ) -> Result<Arc<Self>, String> {
        let provider = match injected_provider {
            Some(provider) => Some(provider),
            None if config.provider == AgentProviderKind::Disabled => None,
            None if config.provider == AgentProviderKind::OpenAi => Some(
                Arc::new(openai::OpenAiProvider::from_config(&config)?) as Arc<dyn AgentProvider>,
            ),
            None => None,
        };

        recover_interrupted_runs(&db, &config).map_err(|error| {
            tracing::error!(target: "marks_server::agent", ?error, "agent recovery failed");
            "agent recovery failed".to_owned()
        })?;

        let hub = Arc::new(Self {
            db,
            admission: Arc::new(Semaphore::new(config.max_concurrent_runs)),
            config,
            provider,
            runs: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
            tasks: Mutex::new(Vec::new()),
        });
        hub.start_maintenance();
        Ok(hub)
    }

    pub fn capabilities(&self) -> Capabilities {
        Capabilities {
            enabled: self.provider.is_some(),
            protocol_version: PROTOCOL_VERSION,
            provider: self.provider.as_ref().map(|provider| provider.id().to_owned()),
            limits: CapabilityLimits {
                max_prompt_bytes: MAX_PROMPT_BYTES,
                max_tools: MAX_TOOLS,
                max_schema_bytes: MAX_SCHEMA_BYTES,
                max_tool_result_bytes: MAX_TOOL_RESULT_BYTES,
                max_output_tokens: self.config.max_output_tokens,
                max_run_ms: self.config.max_runtime_ms,
                max_concurrent_runs_per_session: self
                    .config
                    .max_concurrent_runs_per_session,
            },
            features: CapabilityFeatures {
                sse_replay: true,
                tool_results: true,
                cancellation: true,
                web_mcp: false,
            },
        }
    }

    pub fn enabled(&self) -> bool {
        self.provider.is_some()
    }

    pub async fn start_run(
        self: &Arc<Self>,
        session_id: &str,
        principal_id: &str,
        body: CreateRunBody,
    ) -> ApiResult<RunResponse> {
        validate_create_body(&body)?;
        let provider = self
            .provider
            .as_ref()
            .cloned()
            .ok_or_else(|| ApiError::unavailable("agent is disabled"))?;
        let request_hash = digest_json(&body)?;

        if let Some((run_id, stored_hash)) = self.lookup_request(session_id, &body.request_id)? {
            if stored_hash != request_hash {
                return Err(ApiError::conflict());
            }
            let run = self.load_owned_run(session_id, &run_id)?;
            return Ok(run.response(true));
        }

        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::unavailable("agent capacity reached"))?;
        let now = now_ms();
        let run_id = new_id("run");
        let expires_at = now.saturating_add(self.config.max_runtime_ms);
        let provider_id = provider.id();
        let transaction = self.db.tx(|connection| {
            if let Some((existing_id, existing_hash)) = connection
                .query_row(
                    "SELECT id, request_hash FROM agent_runs
                     WHERE session_id = ?1 AND request_id = ?2",
                    params![session_id, body.request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
                )
                .optional()?
            {
                if existing_hash.as_slice() != request_hash {
                    return Err(ApiError::conflict());
                }
                return Ok(CreateTransaction::Existing {
                    run_id: existing_id,
                });
            }

            let active: i64 = connection.query_row(
                "SELECT COUNT(*) FROM agent_runs
                 WHERE session_id = ?1
                   AND status IN ('queued', 'running', 'waiting_for_tool')",
                params![session_id],
                |row| row.get(0),
            )?;
            if active >= self.config.max_concurrent_runs_per_session as i64 {
                return Err(ApiError::rate_limited());
            }
            let recent: i64 = connection.query_row(
                "SELECT COUNT(*) FROM agent_runs
                 WHERE principal_id = ?1 AND created_at >= ?2",
                params![
                    principal_id,
                    i64::try_from(now.saturating_sub(ONE_HOUR_MS)).unwrap_or(0)
                ],
                |row| row.get(0),
            )?;
            if recent >= i64::from(self.config.max_runs_per_hour) {
                return Err(ApiError::rate_limited());
            }

            connection.execute(
                "INSERT INTO agent_runs
                    (id, session_id, principal_id, document_id, request_id, request_hash,
                     provider, status, created_at, updated_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?8, ?9)",
                params![
                    run_id,
                    session_id,
                    principal_id,
                    body.document_id,
                    body.request_id,
                    request_hash.as_slice(),
                    provider_id,
                    i64::try_from(now).unwrap_or(i64::MAX),
                    i64::try_from(expires_at).unwrap_or(i64::MAX),
                ],
            )?;
            connection.execute(
                "INSERT INTO agent_usage_daily (principal_id, day, run_count)
                 VALUES (?1, ?2, 1)
                 ON CONFLICT(principal_id, day) DO UPDATE
                 SET run_count = run_count + 1",
                params![principal_id, i64::try_from(now / ONE_DAY_MS).unwrap_or(0)],
            )?;
            Ok(CreateTransaction::Created)
        })?;

        if let CreateTransaction::Existing { run_id } = transaction {
            drop(permit);
            let run = self.load_owned_run(session_id, &run_id)?;
            return Ok(run.response(true));
        }

        let run = Arc::new(RunState::new(
            run_id.clone(),
            session_id.to_owned(),
            principal_id.to_owned(),
            body.document_id.clone(),
            now,
            expires_at,
        ));
        self.runs
            .lock()
            .map_err(|_| ApiError::internal())?
            .insert(run_id, run.clone());

        let request = ProviderRequest {
            prompt: body.prompt,
            tools: body.tools.clone(),
            safety_identifier: safety_identifier(principal_id),
            max_output_tokens: self.config.max_output_tokens,
        };
        self.spawn_run(provider, request, body.tools, run.clone(), permit);
        Ok(run.response(false))
    }

    pub(crate) fn load_owned_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> ApiResult<Arc<RunState>> {
        if let Some(run) = self
            .runs
            .lock()
            .map_err(|_| ApiError::internal())?
            .get(run_id)
            .cloned()
        {
            if run.session_id != session_id {
                return Err(ApiError::not_found());
            }
            return Ok(run);
        }

        let persisted = self.db.read(|connection| {
            let row = connection
                .query_row(
                    "SELECT session_id, principal_id, document_id, status, created_at,
                            expires_at, output_text, input_tokens, output_tokens
                     FROM agent_runs WHERE id = ?1",
                    params![run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, Option<String>>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(ApiError::not_found)?;
            if row.0 != session_id {
                return Err(ApiError::not_found());
            }
            let status = RunStatus::from_db(&row.3).ok_or_else(ApiError::internal)?;
            if !status.is_terminal() {
                // All pre-existing non-terminal runs are converted to a durable
                // serverRestart terminal receipt during AgentHub construction.
                return Err(ApiError::unavailable("agent run is recovering"));
            }
            let mut statement = connection.prepare(
                "SELECT sequence, kind, data_json, bytes FROM agent_events
                 WHERE run_id = ?1 ORDER BY sequence ASC",
            )?;
            let events = statement
                .query_map(params![run_id], |event| {
                    Ok((
                        event.get::<_, i64>(0)?,
                        event.get::<_, String>(1)?,
                        event.get::<_, String>(2)?,
                        event.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((row, status, events))
        })?;

        let ((_, principal, document, _, created, expires, output, input, output_tokens), status, rows) =
            persisted;
        let mut events = Vec::with_capacity(rows.len());
        let mut event_bytes = 0_usize;
        for (sequence, kind, data, bytes) in rows {
            let sequence = u64::try_from(sequence).map_err(|_| ApiError::internal())?;
            let data = serde_json::from_str(&data).map_err(|_| ApiError::internal())?;
            event_bytes = event_bytes
                .checked_add(usize::try_from(bytes).map_err(|_| ApiError::internal())?)
                .ok_or_else(ApiError::internal)?;
            events.push(AgentEvent {
                sequence,
                kind,
                data,
            });
        }
        let input_tokens = u64::try_from(input).map_err(|_| ApiError::internal())?;
        let output_tokens = u64::try_from(output_tokens).map_err(|_| ApiError::internal())?;
        let run = Arc::new(RunState {
            id: run_id.to_owned(),
            session_id: session_id.to_owned(),
            principal_id: principal,
            document_id: document,
            created_at_ms: u64::try_from(created).map_err(|_| ApiError::internal())?,
            expires_at_ms: u64::try_from(expires).map_err(|_| ApiError::internal())?,
            cancel: CancellationToken::new(),
            notify: Notify::new(),
            inner: Mutex::new(RunInner {
                status,
                events,
                event_bytes,
                output_text: output.unwrap_or_default(),
                usage: AgentUsage {
                    input_tokens,
                    output_tokens,
                    total_tokens: input_tokens.saturating_add(output_tokens),
                },
                pending_tool: None,
            }),
        });
        self.runs
            .lock()
            .map_err(|_| ApiError::internal())?
            .insert(run_id.to_owned(), run.clone());
        Ok(run)
    }

    pub fn submit_tool_result(
        &self,
        session_id: &str,
        run_id: &str,
        body: ToolResultBody,
    ) -> ApiResult<ToolResultResponse> {
        validate_identifier(&body.request_id, 128, "invalid request id")?;
        validate_identifier(&body.call_id, 128, "invalid call id")?;
        let output_json = serde_json::to_string(&body.output)
            .map_err(|_| ApiError::bad_request("invalid tool result"))?;
        if output_json.len() > MAX_TOOL_RESULT_BYTES {
            return Err(ApiError::bad_request("tool result is too large"));
        }
        let request_hash = digest_json(&body)?;
        let run = self.load_owned_run(session_id, run_id)?;

        let mut inner = run.inner.lock().map_err(|_| ApiError::internal())?;
        if inner.status != RunStatus::WaitingForTool {
            if let Some(replayed) = self.lookup_tool_receipt(run_id, &body, request_hash)? {
                return Ok(ToolResultResponse {
                    run_id: run_id.to_owned(),
                    call_id: body.call_id,
                    accepted: true,
                    replayed,
                });
            }
            return Err(ApiError::conflict());
        }
        let Some(pending) = inner.pending_tool.as_mut() else {
            if let Some(replayed) = self.lookup_tool_receipt(run_id, &body, request_hash)? {
                return Ok(ToolResultResponse {
                    run_id: run_id.to_owned(),
                    call_id: body.call_id,
                    accepted: true,
                    replayed,
                });
            }
            return Err(ApiError::conflict());
        };
        if pending.call_id != body.call_id {
            return Err(ApiError::conflict());
        }
        if pending.result.is_some() {
            drop(inner);
            let replayed = self
                .lookup_tool_receipt(run_id, &body, request_hash)?
                .ok_or_else(ApiError::conflict)?;
            return Ok(ToolResultResponse {
                run_id: run_id.to_owned(),
                call_id: body.call_id,
                accepted: true,
                replayed,
            });
        }

        let inserted = self.db.tx(|connection| {
            let mut statement = connection.prepare(
                "SELECT call_id, request_id, request_hash FROM agent_tool_receipts
                 WHERE run_id = ?1 AND (call_id = ?2 OR request_id = ?3)",
            )?;
            let receipts = statement
                .query_map(params![run_id, body.call_id, body.request_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if !receipts.is_empty() {
                if receipts.len() == 1
                    && receipts[0].0 == body.call_id
                    && receipts[0].1 == body.request_id
                    && receipts[0].2.as_slice() == request_hash
                {
                    return Ok(false);
                }
                return Err(ApiError::conflict());
            }
            connection.execute(
                "INSERT INTO agent_tool_receipts
                    (run_id, call_id, request_id, request_hash, status, output_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    run_id,
                    body.call_id,
                    body.request_id,
                    request_hash.as_slice(),
                    body.status.as_db(),
                    output_json,
                    i64::try_from(now_ms()).unwrap_or(i64::MAX),
                ],
            )?;
            Ok(true)
        })?;
        if !inserted {
            return Ok(ToolResultResponse {
                run_id: run_id.to_owned(),
                call_id: body.call_id,
                accepted: true,
                replayed: true,
            });
        }

        pending.result = Some(ProviderToolResult {
            status: body.status,
            output_json,
        });
        let call_id = body.call_id.clone();
        let status = body.status;
        let event_result = self.append_event_locked(
            &run,
            &mut inner,
            "tool.result.accepted",
            json!({ "callId": call_id, "status": status }),
        );
        drop(inner);
        run.notify.notify_waiters();
        event_result?;
        Ok(ToolResultResponse {
            run_id: run_id.to_owned(),
            call_id: body.call_id,
            accepted: true,
            replayed: false,
        })
    }

    pub fn cancel(&self, session_id: &str, run_id: &str) -> ApiResult<CancelResponse> {
        let run = self.load_owned_run(session_id, run_id)?;
        let status = run.status()?;
        if status.is_terminal() {
            return Ok(CancelResponse {
                run_id: run_id.to_owned(),
                status,
                replayed: true,
            });
        }
        run.cancel.cancel();
        self.finalize(&run, RunStatus::Cancelled, None, AgentUsage::default())?;
        Ok(CancelResponse {
            run_id: run_id.to_owned(),
            status: RunStatus::Cancelled,
            replayed: false,
        })
    }

    pub fn cancel_session(&self, session_id: &str) {
        let runs = match self.runs.lock() {
            Ok(runs) => runs
                .values()
                .filter(|run| run.session_id == session_id)
                .cloned()
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        for run in runs {
            run.cancel.cancel();
            let _ = self.finalize(&run, RunStatus::Cancelled, None, AgentUsage::default());
        }
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let runs = match self.runs.lock() {
            Ok(runs) => runs.values().cloned().collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for run in runs {
            if run.status().is_ok_and(|status| !status.is_terminal()) {
                run.cancel.cancel();
                let _ = self.finalize(&run, RunStatus::Cancelled, None, AgentUsage::default());
            }
        }
        let tasks = self
            .tasks
            .lock()
            .map(|mut tasks| std::mem::take(&mut *tasks))
            .unwrap_or_default();
        for task in tasks {
            let _ = task.await;
        }
    }

    fn lookup_request(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> ApiResult<Option<(String, [u8; 32])>> {
        self.db.read(|connection| {
            connection
                .query_row(
                    "SELECT id, request_hash FROM agent_runs
                     WHERE session_id = ?1 AND request_id = ?2",
                    params![session_id, request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
                )
                .optional()?
                .map(|(id, hash)| Ok((id, crate::store::hash32(hash)?)))
                .transpose()
        })
    }

    fn lookup_tool_receipt(
        &self,
        run_id: &str,
        body: &ToolResultBody,
        request_hash: [u8; 32],
    ) -> ApiResult<Option<bool>> {
        self.db.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT call_id, request_id, request_hash FROM agent_tool_receipts
                 WHERE run_id = ?1 AND (call_id = ?2 OR request_id = ?3)",
            )?;
            let receipts = statement
                .query_map(params![run_id, body.call_id, body.request_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if receipts.is_empty() {
                return Ok(None);
            }
            if receipts.len() == 1
                && receipts[0].0 == body.call_id
                && receipts[0].1 == body.request_id
                && receipts[0].2.as_slice() == request_hash
            {
                return Ok(Some(true));
            }
            Err(ApiError::conflict())
        })
    }

    fn spawn_run(
        self: &Arc<Self>,
        provider: Arc<dyn AgentProvider>,
        request: ProviderRequest,
        tools: Vec<AgentTool>,
        run: Arc<RunState>,
        permit: OwnedSemaphorePermit,
    ) {
        let hub = self.clone();
        let task = tokio::spawn(async move {
            let _permit = permit;
            if hub
                .transition(&run, RunStatus::Running)
                .and_then(|_| {
                    hub.append_event(
                        &run,
                        "run.started",
                        json!({
                            "runId": run.id,
                            "documentId": run.document_id,
                            "status": RunStatus::Running,
                            "createdAtMs": run.created_at_ms,
                        }),
                    )
                })
                .is_err()
            {
                let _ = hub.finalize(
                    &run,
                    RunStatus::Failed,
                    Some("internalError"),
                    AgentUsage::default(),
                );
                return;
            }
            let driver = AgentDriver {
                hub: hub.clone(),
                run: run.clone(),
                tools: Arc::new(tools),
                tool_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            };
            let outcome = tokio::time::timeout(
                std::time::Duration::from_millis(hub.config.max_runtime_ms),
                provider.run(request, driver),
            )
            .await;
            match outcome {
                Ok(Ok(completion)) => {
                    let _ = hub.finalize(
                        &run,
                        RunStatus::Completed,
                        None,
                        completion.usage,
                    );
                }
                Ok(Err(error)) if error.code == "cancelled" || run.cancel.is_cancelled() => {
                    let _ = hub.finalize(
                        &run,
                        RunStatus::Cancelled,
                        None,
                        AgentUsage::default(),
                    );
                }
                Ok(Err(error)) => {
                    let _ = hub.finalize(
                        &run,
                        RunStatus::Failed,
                        Some(error.code),
                        AgentUsage::default(),
                    );
                }
                Err(_) => {
                    run.cancel.cancel();
                    let _ = hub.finalize(
                        &run,
                        RunStatus::Failed,
                        Some("runtimeLimit"),
                        AgentUsage::default(),
                    );
                }
            }
        });
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.push(task);
        }
    }

    fn transition(&self, run: &RunState, status: RunStatus) -> ApiResult<()> {
        let mut inner = run.inner.lock().map_err(|_| ApiError::internal())?;
        if inner.status.is_terminal() {
            return Err(ApiError::conflict());
        }
        self.db.tx(|connection| {
            let changed = connection.execute(
                "UPDATE agent_runs SET status = ?2, updated_at = ?3
                 WHERE id = ?1 AND status NOT IN ('completed', 'failed', 'cancelled')",
                params![
                    run.id,
                    status.as_db(),
                    i64::try_from(now_ms()).unwrap_or(i64::MAX)
                ],
            )?;
            if changed != 1 {
                return Err(ApiError::conflict());
            }
            Ok(())
        })?;
        inner.status = status;
        drop(inner);
        run.notify.notify_waiters();
        Ok(())
    }

    fn append_event(&self, run: &RunState, kind: &str, data: Value) -> ApiResult<AgentEvent> {
        let mut inner = run.inner.lock().map_err(|_| ApiError::internal())?;
        if inner.status.is_terminal() {
            return Err(ApiError::conflict());
        }
        self.append_event_locked(run, &mut inner, kind, data)
    }

    fn append_event_locked(
        &self,
        run: &RunState,
        inner: &mut RunInner,
        kind: &str,
        data: Value,
    ) -> ApiResult<AgentEvent> {
        let data_json = serde_json::to_string(&data).map_err(|_| ApiError::internal())?;
        if data_json.len() > MAX_EVENT_BYTES {
            return Err(ApiError::internal());
        }
        if inner.events.len() >= MAX_EVENTS
            || inner.event_bytes.saturating_add(data_json.len()) > MAX_RUN_EVENT_BYTES
        {
            return Err(ApiError::internal());
        }
        let sequence = inner
            .events
            .last()
            .map_or(1, |event| event.sequence.saturating_add(1));
        self.db.tx(|connection| {
            connection.execute(
                "INSERT INTO agent_events
                    (run_id, sequence, kind, data_json, bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    run.id,
                    i64::try_from(sequence).unwrap_or(i64::MAX),
                    kind,
                    data_json,
                    i64::try_from(data_json.len()).unwrap_or(i64::MAX),
                    i64::try_from(now_ms()).unwrap_or(i64::MAX),
                ],
            )?;
            Ok(())
        })?;
        let event = AgentEvent {
            sequence,
            kind: kind.to_owned(),
            data,
        };
        inner.event_bytes += data_json.len();
        inner.events.push(event.clone());
        run.notify.notify_waiters();
        Ok(event)
    }

    fn finalize(
        &self,
        run: &RunState,
        status: RunStatus,
        code: Option<&'static str>,
        usage: AgentUsage,
    ) -> ApiResult<()> {
        debug_assert!(status.is_terminal());
        let mut inner = run.inner.lock().map_err(|_| ApiError::internal())?;
        if inner.status.is_terminal() {
            return Ok(());
        }
        let (kind, data) = match status {
            RunStatus::Completed => (
                "run.completed",
                json!({
                    "status": RunStatus::Completed,
                    "outputText": inner.output_text,
                    "usage": usage,
                }),
            ),
            RunStatus::Failed => (
                "run.failed",
                json!({ "status": RunStatus::Failed, "code": code.unwrap_or("providerError") }),
            ),
            RunStatus::Cancelled => (
                "run.cancelled",
                json!({ "status": RunStatus::Cancelled }),
            ),
            _ => return Err(ApiError::internal()),
        };
        let data_json = serde_json::to_string(&data).map_err(|_| ApiError::internal())?;
        if data_json.len() > MAX_EVENT_BYTES
            || inner.events.len() >= MAX_EVENTS
            || inner.event_bytes.saturating_add(data_json.len()) > MAX_RUN_EVENT_BYTES
        {
            return Err(ApiError::internal());
        }
        let sequence = inner
            .events
            .last()
            .map_or(1, |event| event.sequence.saturating_add(1));
        let now = now_ms();
        let output = (status == RunStatus::Completed).then(|| inner.output_text.clone());
        self.db.tx(|connection| {
            connection.execute(
                "UPDATE agent_runs
                 SET status = ?2, updated_at = ?3, terminal_code = ?4, output_text = ?5,
                     input_tokens = ?6, output_tokens = ?7
                 WHERE id = ?1 AND status NOT IN ('completed', 'failed', 'cancelled')",
                params![
                    run.id,
                    status.as_db(),
                    i64::try_from(now).unwrap_or(i64::MAX),
                    code,
                    output,
                    i64::try_from(usage.input_tokens).unwrap_or(i64::MAX),
                    i64::try_from(usage.output_tokens).unwrap_or(i64::MAX),
                ],
            )?;
            connection.execute(
                "INSERT INTO agent_events
                    (run_id, sequence, kind, data_json, bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    run.id,
                    i64::try_from(sequence).unwrap_or(i64::MAX),
                    kind,
                    data_json,
                    i64::try_from(data_json.len()).unwrap_or(i64::MAX),
                    i64::try_from(now).unwrap_or(i64::MAX),
                ],
            )?;
            if status == RunStatus::Completed {
                connection.execute(
                    "UPDATE agent_usage_daily
                     SET input_tokens = input_tokens + ?3,
                         output_tokens = output_tokens + ?4
                     WHERE principal_id = ?1 AND day = ?2",
                    params![
                        run.principal_id,
                        i64::try_from(run.created_at_ms / ONE_DAY_MS).unwrap_or(0),
                        i64::try_from(usage.input_tokens).unwrap_or(i64::MAX),
                        i64::try_from(usage.output_tokens).unwrap_or(i64::MAX),
                    ],
                )?;
            }
            Ok(())
        })?;
        inner.status = status;
        inner.usage = usage;
        inner.pending_tool = None;
        inner.event_bytes += data_json.len();
        inner.events.push(AgentEvent {
            sequence,
            kind: kind.to_owned(),
            data,
        });
        drop(inner);
        run.notify.notify_waiters();
        Ok(())
    }

    fn start_maintenance(self: &Arc<Self>) {
        let hub = self.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = hub.shutdown.cancelled() => break,
                    _ = interval.tick() => hub.sweep_expired(),
                }
            }
        });
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.push(task);
        }
    }

    fn sweep_expired(&self) {
        let cutoff = now_ms().saturating_sub(self.config.event_retention_ms);
        if let Ok(mut runs) = self.runs.lock() {
            runs.retain(|_, run| {
                !run.status().is_ok_and(RunStatus::is_terminal) || run.expires_at_ms >= cutoff
            });
        }
        let _ = self.db.tx(|connection| {
            connection.execute(
                "DELETE FROM agent_runs
                 WHERE status IN ('completed', 'failed', 'cancelled') AND expires_at < ?1",
                params![i64::try_from(cutoff).unwrap_or(0)],
            )?;
            Ok(())
        });
    }
}

impl RunState {
    fn new(
        id: String,
        session_id: String,
        principal_id: String,
        document_id: String,
        created_at_ms: u64,
        expires_at_ms: u64,
    ) -> Self {
        Self {
            id,
            session_id,
            principal_id,
            document_id,
            created_at_ms,
            expires_at_ms,
            cancel: CancellationToken::new(),
            notify: Notify::new(),
            inner: Mutex::new(RunInner {
                status: RunStatus::Queued,
                events: Vec::new(),
                event_bytes: 0,
                output_text: String::new(),
                usage: AgentUsage::default(),
                pending_tool: None,
            }),
        }
    }

    fn response(&self, replayed: bool) -> RunResponse {
        RunResponse {
            run_id: self.id.clone(),
            status: self.status().unwrap_or(RunStatus::Failed),
            events_url: format!("/v1/agent/runs/{}/events", self.id),
            created_at_ms: self.created_at_ms,
            expires_at_ms: self.expires_at_ms,
            replayed,
        }
    }

    pub(crate) fn status(&self) -> ApiResult<RunStatus> {
        self.inner
            .lock()
            .map(|inner| inner.status)
            .map_err(|_| ApiError::internal())
    }

    pub(crate) async fn next_event(&self, after: u64) -> Option<AgentEvent> {
        loop {
            let notified = self.notify.notified();
            let terminal = match self.inner.lock() {
                Ok(inner) => {
                    if let Some(event) = inner
                        .events
                        .iter()
                        .find(|event| event.sequence > after)
                        .cloned()
                    {
                        return Some(event);
                    }
                    inner.status.is_terminal()
                }
                Err(_) => return None,
            };
            if terminal {
                return None;
            }
            notified.await;
        }
    }
}

impl AgentDriver {
    pub fn emit_text(&self, text: &str) -> Result<(), ProviderError> {
        if text.is_empty() {
            return Ok(());
        }
        if self.run.cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        {
            let inner = self
                .run
                .inner
                .lock()
                .map_err(|_| ProviderError::new("internalError"))?;
            if inner.output_text.len().saturating_add(text.len()) > MAX_ASSISTANT_OUTPUT_BYTES {
                return Err(ProviderError::new("outputLimit"));
            }
        }
        self.hub
            .append_event(&self.run, "assistant.delta", json!({ "text": text }))
            .map_err(|_| ProviderError::new("eventLimit"))?;
        let mut inner = self
            .run
            .inner
            .lock()
            .map_err(|_| ProviderError::new("internalError"))?;
        inner.output_text.push_str(text);
        Ok(())
    }

    pub async fn call_tool(
        &self,
        call: ProviderToolCall,
    ) -> Result<ProviderToolResult, ProviderError> {
        if self.run.cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        let count = self
            .tool_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1);
        if count > MAX_TOOL_CALLS {
            return Err(ProviderError::new("toolCallLimit"));
        }
        validate_identifier(&call.call_id, 128, "invalid call id")
            .map_err(|_| ProviderError::new("invalidToolCall"))?;
        let tool = self
            .tools
            .iter()
            .find(|tool| tool.name == call.name)
            .cloned()
            .ok_or_else(|| ProviderError::new("unknownTool"))?;
        let arguments_json = serde_json::to_string(&call.arguments)
            .map_err(|_| ProviderError::new("invalidToolCall"))?;
        if arguments_json.len() > MAX_TOOL_RESULT_BYTES || !call.arguments.is_object() {
            return Err(ProviderError::new("invalidToolCall"));
        }
        {
            let mut inner = self
                .run
                .inner
                .lock()
                .map_err(|_| ProviderError::new("internalError"))?;
            if inner.pending_tool.is_some() {
                return Err(ProviderError::new("parallelToolCall"));
            }
            inner.pending_tool = Some(PendingTool {
                call_id: call.call_id.clone(),
                result: None,
            });
        }
        self.hub
            .transition(&self.run, RunStatus::WaitingForTool)
            .map_err(|_| ProviderError::new("internalError"))?;
        if self
            .hub
            .append_event(
                &self.run,
                "tool.call",
                json!({
                    "callId": call.call_id,
                    "commandId": tool.command_id,
                    "name": tool.name,
                    "arguments": call.arguments,
                    "effect": tool.effect,
                    "durability": tool.durability,
                }),
            )
            .is_err()
        {
            if let Ok(mut inner) = self.run.inner.lock() {
                inner.pending_tool = None;
            }
            return Err(ProviderError::new("eventLimit"));
        }

        let wait = async {
            loop {
                let notified = self.run.notify.notified();
                if let Ok(mut inner) = self.run.inner.lock() {
                    if let Some(result) = inner
                        .pending_tool
                        .as_mut()
                        .and_then(|pending| pending.result.take())
                    {
                        inner.pending_tool = None;
                        return Ok(result);
                    }
                } else {
                    return Err(ProviderError::new("internalError"));
                }
                notified.await;
            }
        };
        let result = tokio::select! {
            _ = self.run.cancel.cancelled() => Err(ProviderError::cancelled()),
            result = tokio::time::timeout(
                std::time::Duration::from_millis(self.hub.config.tool_wait_ms),
                wait,
            ) => result.map_err(|_| ProviderError::new("toolTimeout"))?,
        }?;
        self.hub
            .transition(&self.run, RunStatus::Running)
            .map_err(|_| ProviderError::new("internalError"))?;
        Ok(result)
    }

    pub fn is_cancelled(&self) -> bool {
        self.run.cancel.is_cancelled()
    }
}

fn validate_create_body(body: &CreateRunBody) -> ApiResult<()> {
    validate_identifier(&body.request_id, 128, "invalid request id")?;
    if body.prompt.trim().is_empty() || body.prompt.len() > MAX_PROMPT_BYTES {
        return Err(ApiError::bad_request("invalid prompt"));
    }
    if body.tools.len() > MAX_TOOLS {
        return Err(ApiError::bad_request("too many tools"));
    }
    let mut command_ids = HashSet::new();
    let mut names = HashSet::new();
    let mut total_schema_bytes = 0_usize;
    for tool in &body.tools {
        validate_identifier(&tool.command_id, 128, "invalid command id")?;
        validate_function_name(&tool.name)?;
        if !command_ids.insert(&tool.command_id) || !names.insert(&tool.name) {
            return Err(ApiError::bad_request("duplicate tool"));
        }
        if tool.description.trim().is_empty()
            || tool.description.len() > MAX_TOOL_DESCRIPTION_BYTES
            || tool.description.chars().any(char::is_control)
        {
            return Err(ApiError::bad_request("invalid tool description"));
        }
        if !tool.input_schema.is_object() {
            return Err(ApiError::bad_request("invalid tool schema"));
        }
        let bytes = serde_json::to_vec(&tool.input_schema)
            .map_err(|_| ApiError::bad_request("invalid tool schema"))?
            .len();
        total_schema_bytes = total_schema_bytes
            .checked_add(bytes)
            .ok_or_else(|| ApiError::bad_request("tool schemas are too large"))?;
        let mut nodes = 0_usize;
        validate_json_depth(&tool.input_schema, 1, &mut nodes)?;
    }
    if total_schema_bytes > MAX_SCHEMA_BYTES {
        return Err(ApiError::bad_request("tool schemas are too large"));
    }
    Ok(())
}

fn validate_json_depth(value: &Value, depth: usize, nodes: &mut usize) -> ApiResult<()> {
    *nodes = nodes.saturating_add(1);
    if depth > MAX_SCHEMA_DEPTH || *nodes > MAX_SCHEMA_NODES {
        return Err(ApiError::bad_request("tool schema is too complex"));
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_json_depth(value, depth.saturating_add(1), nodes)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_json_depth(value, depth.saturating_add(1), nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_identifier(value: &str, max: usize, message: &'static str) -> ApiResult<()> {
    if value.is_empty()
        || value.len() > max
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(ApiError::bad_request(message));
    }
    Ok(())
}

fn validate_function_name(value: &str) -> ApiResult<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ApiError::bad_request("invalid tool name"));
    }
    Ok(())
}

fn digest_json(value: &impl Serialize) -> ApiResult<[u8; 32]> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::bad_request("invalid request"))?;
    Ok(Sha256::digest(bytes).into())
}

fn safety_identifier(principal_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"marks-agent-safety-identifier-v1\0");
    digest.update(principal_id.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn recover_interrupted_runs(db: &Db, config: &AgentConfig) -> ApiResult<()> {
    let now = now_ms();
    db.tx(|connection| {
        connection.execute(
            "DELETE FROM agent_runs
             WHERE status IN ('completed', 'failed', 'cancelled') AND expires_at < ?1",
            params![i64::try_from(now.saturating_sub(config.event_retention_ms)).unwrap_or(0)],
        )?;
        let mut statement = connection.prepare(
            "SELECT id, COALESCE(MAX(e.sequence), 0)
             FROM agent_runs r LEFT JOIN agent_events e ON e.run_id = r.id
             WHERE r.status IN ('queued', 'running', 'waiting_for_tool')
             GROUP BY r.id",
        )?;
        let interrupted = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (run_id, last_sequence) in interrupted {
            let sequence = last_sequence.saturating_add(1);
            let data = serde_json::to_string(
                &json!({ "status": RunStatus::Failed, "code": "serverRestart" }),
            )
            .map_err(|_| ApiError::internal())?;
            connection.execute(
                "UPDATE agent_runs
                 SET status = 'failed', terminal_code = 'serverRestart', updated_at = ?2
                 WHERE id = ?1",
                params![run_id, i64::try_from(now).unwrap_or(i64::MAX)],
            )?;
            connection.execute(
                "INSERT INTO agent_events
                    (run_id, sequence, kind, data_json, bytes, created_at)
                 VALUES (?1, ?2, 'run.failed', ?3, ?4, ?5)",
                params![
                    run_id,
                    sequence,
                    data,
                    i64::try_from(data.len()).unwrap_or(i64::MAX),
                    i64::try_from(now).unwrap_or(i64::MAX),
                ],
            )?;
        }
        Ok(())
    })
}
