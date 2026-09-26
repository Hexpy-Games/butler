use serde_json::Value;

use super::contracts::{ModelRoundTool, ModelRoundToolCall, ToolChoice};

pub(crate) struct RenderedGuidedPrompt {
    pub prompt: String,
    pub instructions: Option<String>,
    pub tools: Vec<ModelRoundTool>,
    pub tool_choice: Option<ToolChoice>,
    pub route_context: Option<Value>,
    pub resumed_tool_call: Option<ModelRoundToolCall>,
    pub max_output_tokens: Option<f64>,
    pub attachments: Vec<Value>,
    pub image_carrier: Option<Value>,
    pub image_capability: Option<Value>,
    pub image_manifests: Vec<Value>,
    pub butler_data: Option<String>,
    pub usage_attribution: Option<super::contracts::UsageAttribution>,
    pub cache_scope: Option<String>,
    pub stable_provider_cache_prefix: Option<Value>,
    pub route_transport_attempt_ordinal: Option<u32>,
    pub synthesize_after_tool_candidate: bool,
    pub synthesize_after_tool_empty: bool,
}
