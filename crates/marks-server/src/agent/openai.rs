//! OpenAI Responses API adapter.
//!
//! This adapter is deliberately stateless (`store:false`). It replays every
//! prior output item, including encrypted reasoning, when a function result
//! starts the next turn. The endpoint, model, and credential are server-owned.

use super::AgentDriver;
use super::protocol::{AgentTool, AgentUsage};
use super::provider::{
    AgentProvider, ProviderCompletion, ProviderError, ProviderRequest, ProviderToolCall,
};
use crate::config::AgentConfig;
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde_json::{Value, json};
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const RESPONSES_ENDPOINT: &str = "https://api.openai.com/v1/responses";
const MAX_CREDENTIAL_BYTES: u64 = 16 * 1024;
const MAX_UPSTREAM_BYTES: usize = 2 * 1024 * 1024;
const MAX_UPSTREAM_EVENT_BYTES: usize = 256 * 1024;
const DELTA_CHUNK_BYTES: usize = 1_024;
const INSTRUCTIONS: &str = "You operate only the supplied Marks ribbon commands. Use a function when the user's request calls for a provided command. Never claim a command ran until its function output is returned. Do not ask for or infer document source that was not included in the user's prompt. Keep presentation text concise.";

pub struct OpenAiProvider {
    client: Client,
    endpoint: Url,
    api_key: Secret,
    model: Arc<str>,
}

struct Secret(Arc<str>);

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret([REDACTED])")
    }
}

impl fmt::Debug for OpenAiProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiProvider")
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key)
            .field("model", &self.model)
            .finish()
    }
}

#[derive(Debug)]
struct Turn {
    output: Vec<Value>,
    function_call: Option<ProviderToolCall>,
    usage: AgentUsage,
}

impl OpenAiProvider {
    pub fn from_config(config: &AgentConfig) -> Result<Self, String> {
        let path = config
            .openai_api_key_file
            .as_deref()
            .ok_or_else(|| "OpenAI credential file is not configured".to_owned())?;
        let key = read_credential(path)?;
        let model = config
            .openai_model
            .as_deref()
            .ok_or_else(|| "OpenAI model is not configured".to_owned())?;
        Self::from_parts(
            Url::parse(RESPONSES_ENDPOINT).expect("fixed Responses URL"),
            key,
            model,
        )
    }

    fn from_parts(endpoint: Url, api_key: String, model: &str) -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(150))
            .build()
            .map_err(|_| "cannot construct OpenAI HTTP client".to_owned())?;
        Ok(Self {
            client,
            endpoint,
            api_key: Secret(Arc::from(api_key)),
            model: Arc::from(model.to_owned()),
        })
    }

    async fn execute_turn(
        &self,
        request: &ProviderRequest,
        input: &[Value],
        mut emit_delta: impl FnMut(&str) -> Result<(), ProviderError>,
    ) -> Result<Turn, ProviderError> {
        let tools = request.tools.iter().map(openai_tool).collect::<Vec<_>>();
        let body = json!({
            "model": self.model.as_ref(),
            "instructions": INSTRUCTIONS,
            "input": input,
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "max_output_tokens": request.max_output_tokens,
            "max_tool_calls": super::protocol::MAX_TOOL_CALLS,
            "store": false,
            "stream": true,
            "include": ["reasoning.encrypted_content"],
            "safety_identifier": request.safety_identifier,
            "truncation": "disabled",
        });
        let response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.api_key.0.as_ref())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::USER_AGENT, "marks-server/agent-v1")
            .json(&body)
            .send()
            .await
            .map_err(|_| ProviderError::new("providerUnavailable"))?;
        if response.status() != StatusCode::OK {
            tracing::warn!(
                target: "marks_server::agent::openai",
                status = %response.status(),
                "OpenAI Responses request rejected"
            );
            return Err(if response.status() == StatusCode::TOO_MANY_REQUESTS {
                ProviderError::new("providerRateLimited")
            } else {
                ProviderError::new("providerRejected")
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_UPSTREAM_BYTES as u64)
        {
            return Err(ProviderError::new("providerResponseLimit"));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = Vec::<u8>::new();
        let mut total_bytes = 0_usize;
        let mut completed = None::<Value>;
        let mut delta_buffer = String::new();
        let mut emitted_any = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ProviderError::new("providerUnavailable"))?;
            total_bytes = total_bytes
                .checked_add(chunk.len())
                .ok_or_else(|| ProviderError::new("providerResponseLimit"))?;
            if total_bytes > MAX_UPSTREAM_BYTES {
                return Err(ProviderError::new("providerResponseLimit"));
            }
            buffer.extend_from_slice(&chunk);
            if buffer.len() > MAX_UPSTREAM_EVENT_BYTES && frame_boundary(&buffer).is_none() {
                return Err(ProviderError::new("malformedProviderResponse"));
            }
            while let Some((position, separator_bytes)) = frame_boundary(&buffer) {
                let remaining = buffer.split_off(position + separator_bytes);
                let frame = std::mem::replace(&mut buffer, remaining);
                process_frame(
                    &frame[..position],
                    &mut completed,
                    &mut delta_buffer,
                    &mut emitted_any,
                    &mut emit_delta,
                )?;
            }
        }
        if buffer.iter().any(|byte| !byte.is_ascii_whitespace()) {
            process_frame(
                &buffer,
                &mut completed,
                &mut delta_buffer,
                &mut emitted_any,
                &mut emit_delta,
            )?;
        }
        if !delta_buffer.is_empty() {
            emit_delta(&delta_buffer)?;
            emitted_any = true;
        }

        let response = completed.ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
        let status = response
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
        if status != "completed" {
            return Err(ProviderError::new("providerIncomplete"));
        }
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
        if !emitted_any {
            let fallback = output_text(&output);
            if !fallback.is_empty() {
                emit_delta(&fallback)?;
            }
        }
        let function_calls = output
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .map(parse_function_call)
            .collect::<Result<Vec<_>, _>>()?;
        if function_calls.len() > 1 {
            return Err(ProviderError::new("parallelToolCall"));
        }
        let usage = parse_usage(response.get("usage"))?;
        Ok(Turn {
            output,
            function_call: function_calls.into_iter().next(),
            usage,
        })
    }
}

#[async_trait]
impl AgentProvider for OpenAiProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    async fn run(
        &self,
        request: ProviderRequest,
        driver: AgentDriver,
    ) -> Result<ProviderCompletion, ProviderError> {
        let mut input = vec![json!({
            "role": "user",
            "content": [{ "type": "input_text", "text": request.prompt }],
        })];
        let mut usage = AgentUsage::default();
        loop {
            if driver.is_cancelled() {
                return Err(ProviderError::cancelled());
            }
            let turn = tokio::select! {
                _ = driver.cancelled() => return Err(ProviderError::cancelled()),
                turn = self.execute_turn(&request, &input, |delta| driver.emit_text(delta)) => turn?,
            };
            usage.input_tokens = usage.input_tokens.saturating_add(turn.usage.input_tokens);
            usage.output_tokens = usage.output_tokens.saturating_add(turn.usage.output_tokens);
            usage.total_tokens = usage.input_tokens.saturating_add(usage.output_tokens);
            input.extend(turn.output);
            let Some(call) = turn.function_call else {
                return Ok(ProviderCompletion { usage });
            };
            let call_id = call.call_id.clone();
            let result = driver.call_tool(call).await?;
            input.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": serde_json::to_string(&json!({
                    "status": result.status,
                    "output": serde_json::from_str::<Value>(&result.output_json)
                        .unwrap_or(Value::Null),
                })).map_err(|_| ProviderError::new("internalError"))?,
            }));
        }
    }
}

fn openai_tool(tool: &AgentTool) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.input_schema,
        "strict": true,
    })
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

fn process_frame(
    frame: &[u8],
    completed: &mut Option<Value>,
    delta_buffer: &mut String,
    emitted_any: &mut bool,
    emit_delta: &mut impl FnMut(&str) -> Result<(), ProviderError>,
) -> Result<(), ProviderError> {
    if frame.len() > MAX_UPSTREAM_EVENT_BYTES {
        return Err(ProviderError::new("providerResponseLimit"));
    }
    let frame =
        std::str::from_utf8(frame).map_err(|_| ProviderError::new("malformedProviderResponse"))?;
    let mut data = String::new();
    for line in frame.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let event: Value =
        serde_json::from_str(&data).map_err(|_| ProviderError::new("malformedProviderResponse"))?;
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => {
            let delta = event
                .get("delta")
                .and_then(Value::as_str)
                .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
            delta_buffer.push_str(delta);
            if delta_buffer.len() >= DELTA_CHUNK_BYTES {
                emit_delta(delta_buffer)?;
                delta_buffer.clear();
                *emitted_any = true;
            }
        }
        Some("response.completed") => {
            *completed = Some(
                event
                    .get("response")
                    .cloned()
                    .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?,
            );
        }
        Some("response.failed" | "response.incomplete" | "error") => {
            return Err(ProviderError::new("providerIncomplete"));
        }
        Some(_) => {}
        None => return Err(ProviderError::new("malformedProviderResponse")),
    }
    Ok(())
}

fn parse_function_call(value: &Value) -> Result<ProviderToolCall, ProviderError> {
    let call_id = value
        .get("call_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?
        .to_owned();
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?
        .to_owned();
    let arguments = value
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
    if arguments.len() > super::protocol::MAX_TOOL_RESULT_BYTES {
        return Err(ProviderError::new("invalidToolCall"));
    }
    let arguments =
        serde_json::from_str(arguments).map_err(|_| ProviderError::new("invalidToolCall"))?;
    Ok(ProviderToolCall {
        call_id,
        name,
        arguments,
    })
}

fn output_text(output: &[Value]) -> String {
    let mut text = String::new();
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(content) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for part in content {
            if part.get("type").and_then(Value::as_str) == Some("output_text")
                && let Some(value) = part.get("text").and_then(Value::as_str)
            {
                text.push_str(value);
            }
        }
    }
    text
}

fn parse_usage(value: Option<&Value>) -> Result<AgentUsage, ProviderError> {
    let Some(value) = value else {
        return Ok(AgentUsage::default());
    };
    let input_tokens = value
        .get("input_tokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
    let output_tokens = value
        .get("output_tokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| ProviderError::new("malformedProviderResponse"))?;
    let total_tokens = value
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));
    Ok(AgentUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

fn read_credential(path: &Path) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "cannot read OpenAI credential file".to_owned())?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
        return Err("OpenAI credential file is invalid".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("OpenAI credential file must not be group/world accessible".to_owned());
        }
    }
    let file =
        std::fs::File::open(path).map_err(|_| "cannot read OpenAI credential file".to_owned())?;
    let mut bytes = Vec::new();
    file.take(MAX_CREDENTIAL_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read OpenAI credential file".to_owned())?;
    if bytes.len() as u64 > MAX_CREDENTIAL_BYTES {
        return Err("OpenAI credential file is invalid".to_owned());
    }
    let key = std::str::from_utf8(&bytes)
        .map_err(|_| "OpenAI credential file is invalid".to_owned())?
        .trim_end_matches(['\r', '\n']);
    if key.len() < 8 || key.chars().any(char::is_whitespace) || key.chars().any(char::is_control) {
        return Err("OpenAI credential file is invalid".to_owned());
    }
    Ok(key.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn malformed_upstream_is_normalized_without_echoing_its_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut request = vec![0_u8; 8 * 1024];
            let _ = socket.read(&mut request).await.unwrap();
            let body = "data: definitely-not-json\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let provider = OpenAiProvider::from_parts(
            Url::parse(&format!("http://{address}/v1/responses")).unwrap(),
            "test-secret-key".to_owned(),
            "test-model",
        )
        .unwrap();
        let request = ProviderRequest {
            prompt: "hello".to_owned(),
            tools: Vec::new(),
            safety_identifier: "stable".to_owned(),
            max_output_tokens: 128,
        };
        let error = provider
            .execute_turn(
                &request,
                &[json!({ "role": "user", "content": "hello" })],
                |_| Ok(()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "malformedProviderResponse");
        server.await.unwrap();
    }

    #[test]
    fn debug_output_redacts_the_credential() {
        let provider = OpenAiProvider::from_parts(
            Url::parse(RESPONSES_ENDPOINT).unwrap(),
            "very-secret-key".to_owned(),
            "test-model",
        )
        .unwrap();
        let debug = format!("{provider:?}");
        assert!(!debug.contains("very-secret-key"));
        assert!(debug.contains("[REDACTED]"));
    }
}
