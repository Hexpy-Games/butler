//! Model identities with provider-specific wire behavior, owned by the catalog.
pub const ZAI_IMAGE_MODEL: &str = include_str!("zai-image-model.txt");
pub const ANTHROPIC_ADAPTIVE_MODELS: &[&str] = &[
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-5",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
];
pub const ANTHROPIC_BUDGET_MODEL: &str = "claude-haiku-4-5";
pub const OPENCODE_THINKING_MODEL: &str = "glm-5.3";
pub const OPENAI_EXPLICIT_CACHE_MODELS: &[&str] = &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
pub const KIMI_ADAPTIVE_MODEL: &str = "kimi-k3";
pub const ZAI_THINKING_REFS: &[&str] = &[
    "zai/glm-5.3",
    "zai/glm-5.3-flash",
    "zai-api/glm-5.3",
    "zai-api/glm-5.3-flash",
];

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Hosted chat extensions, declared by the provider rather than the carrier.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct ChatWirePolicy {
    pub reasoning_request: ChatReasoningRequest,
    pub reasoning_response_field: Option<ChatReasoningField>,
    pub reasoning_history: ChatReasoningHistory,
    pub tool_choice_required_while_thinking: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatReasoningRequest {
    #[default]
    None,
    ReasoningEffort,
    ThinkingToggleWithEffort,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatReasoningField {
    ReasoningContent,
    Reasoning,
}
impl ChatReasoningField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReasoningContent => "reasoning_content",
            Self::Reasoning => "reasoning",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatReasoningHistory {
    #[default]
    Omit,
    Echo,
}

impl ChatWirePolicy {
    /// Explicit `none` disables thinking; absent effort leaves provider defaults.
    pub fn apply(self, body: &mut Map<String, Value>, effort: Option<&str>) {
        let thinking = effort != Some("none");
        match self.reasoning_request {
            ChatReasoningRequest::None => return,
            ChatReasoningRequest::ReasoningEffort => {}
            ChatReasoningRequest::ThinkingToggleWithEffort => {
                body.insert(
                    "thinking".into(),
                    json!({"type":if thinking {"enabled"} else {"disabled"}}),
                );
                if thinking
                    && !self.tool_choice_required_while_thinking
                    && body
                        .get("tool_choice")
                        .is_some_and(|choice| choice == "required" || choice.is_object())
                {
                    body.insert("tool_choice".into(), "auto".into());
                }
            }
        }
        if let Some(effort) = effort {
            body.insert("reasoning_effort".into(), effort.into());
        }
    }
}
