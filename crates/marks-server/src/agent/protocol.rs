use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_AGENT_BODY_BYTES: usize = 128 * 1024;
pub const MAX_PROMPT_BYTES: usize = 8 * 1024;
pub const MAX_TOOLS: usize = 96;
pub const MAX_TOOL_DESCRIPTION_BYTES: usize = 512;
pub const MAX_SCHEMA_BYTES: usize = 64 * 1024;
pub const MAX_SCHEMA_DEPTH: usize = 8;
pub const MAX_SCHEMA_NODES: usize = 512;
pub const MAX_TOOL_RESULT_BYTES: usize = 16 * 1024;
pub const MAX_ASSISTANT_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_EVENTS: usize = 512;
pub const MAX_EVENT_BYTES: usize = 128 * 1024;
pub const MAX_RUN_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_TOOL_CALLS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingForTool,
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingForTool => "waiting_for_tool",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "waiting_for_tool" => Some(Self::WaitingForTool),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ToolEffect {
    Read,
    Write,
    Destructive,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ToolDurability {
    Ephemeral,
    Document,
    External,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTool {
    pub command_id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub effect: ToolEffect,
    pub durability: ToolDurability,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRunBody {
    pub request_id: String,
    pub document_id: String,
    pub prompt: String,
    pub tools: Vec<AgentTool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub run_id: String,
    pub status: RunStatus,
    pub events_url: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub replayed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ToolResultStatus {
    Succeeded,
    Failed,
    Cancelled,
}

impl ToolResultStatus {
    pub(crate) fn as_db(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultBody {
    pub request_id: String,
    pub call_id: String,
    pub status: ToolResultStatus,
    pub output: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultResponse {
    pub run_id: String,
    pub call_id: String,
    pub accepted: bool,
    pub replayed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResponse {
    pub run_id: String,
    pub status: RunStatus,
    pub replayed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub enabled: bool,
    pub protocol_version: u8,
    pub provider: Option<String>,
    pub limits: CapabilityLimits,
    pub features: CapabilityFeatures,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityLimits {
    pub max_prompt_bytes: usize,
    pub max_tools: usize,
    pub max_schema_bytes: usize,
    pub max_tool_result_bytes: usize,
    pub max_output_tokens: u32,
    pub max_run_ms: u64,
    pub max_concurrent_runs_per_session: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFeatures {
    pub sse_replay: bool,
    pub tool_results: bool,
    pub cancellation: bool,
    pub web_mcp: bool,
}

#[derive(Clone, Debug)]
pub struct AgentEvent {
    pub sequence: u64,
    pub kind: String,
    pub data: Value,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}
