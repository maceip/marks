use super::AgentDriver;
use super::protocol::{AgentTool, AgentUsage, ToolResultStatus};
use async_trait::async_trait;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct ProviderRequest {
    pub prompt: String,
    pub tools: Vec<AgentTool>,
    pub safety_identifier: String,
    pub max_output_tokens: u32,
}

#[derive(Clone, Debug)]
pub struct ProviderToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug)]
pub struct ProviderToolResult {
    pub status: ToolResultStatus,
    pub output_json: String,
}

#[derive(Clone, Copy, Debug)]
pub struct ProviderCompletion {
    pub usage: AgentUsage,
}

#[derive(Clone, Copy, Debug)]
pub struct ProviderError {
    pub code: &'static str,
}

impl ProviderError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub const fn cancelled() -> Self {
        Self::new("cancelled")
    }
}

#[async_trait]
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &'static str;

    async fn run(
        &self,
        request: ProviderRequest,
        driver: AgentDriver,
    ) -> Result<ProviderCompletion, ProviderError>;
}
