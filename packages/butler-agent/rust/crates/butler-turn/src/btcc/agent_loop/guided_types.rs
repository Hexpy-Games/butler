use serde_json::Value;

use super::contracts::{ModelRoundTool, ModelRoundToolCall, ToolChoice, UsageAttribution};

/// What the prompt port renders for a guided turn before its first model round.
///
/// The required core is the prompt and its tool surface; image inputs and
/// provider request options are grouped so a prompt without them can use
/// `Default::default()`.
pub struct RenderedGuidedPrompt {
    /// The user-facing prompt sent as the first user message.
    pub prompt: String,
    /// System instructions; `None` sends none.
    pub instructions: Option<String>,
    /// The fallback tool surface when the tool port does not resolve its own.
    pub tools: Vec<ModelRoundTool>,
    /// Forces tool use on working rounds; the final-report round never forces it.
    pub tool_choice: Option<ToolChoice>,
    /// A tool call accepted before the loop started, replayed as the first round.
    pub resumed_tool_call: Option<ModelRoundToolCall>,
    /// Admitted image inputs for the provider request.
    pub images: PromptImages,
    /// Provider request options that stay fixed for every round of the turn.
    pub request: RoundRequestOptions,
    /// When the loop asks the journal to synthesize a final answer.
    pub final_synthesis: FinalSynthesis,
}

/// Admitted image inputs of a turn.
///
/// The values are provider passthrough: image admission validated them and the
/// provider serializer owns their shape, so they stay `Value` here.
#[derive(Clone, Debug, Default)]
pub struct PromptImages {
    /// The admitted image attachments.
    pub attachments: Vec<Value>,
    /// The admission tuple naming the carrier the provider must use.
    pub carrier: Option<Value>,
    /// The model's admitted visual capability.
    pub capability: Option<Value>,
    /// Visual manifests of the attachments, in attachment order.
    pub manifests: Vec<Value>,
}

/// Provider request options that stay fixed across the rounds of one turn.
#[derive(Clone, Debug, Default)]
pub struct RoundRequestOptions {
    /// Output-token ceiling; `None` uses the provider default.
    pub max_output_tokens: Option<f64>,
    /// Route context forwarded to the provider route (passthrough JSON).
    pub route_context: Option<Value>,
    /// Butler data directory the provider may reference.
    pub butler_data: Option<String>,
    /// Usage attribution; its round index is offset by the loop's round count.
    pub usage_attribution: Option<UsageAttribution>,
    /// Provider prompt-cache scope key.
    pub cache_scope: Option<String>,
    /// Stable provider cache prefix (passthrough JSON owned by the provider).
    pub stable_provider_cache_prefix: Option<Value>,
    /// Transport attempt ordinal of the route, when the route pins one.
    pub route_transport_attempt_ordinal: Option<u32>,
}

/// When the loop replaces a final reply after tool use with a journal-synthesized one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FinalSynthesis {
    /// Never synthesize; the model's reply is final.
    #[default]
    Never,
    /// Synthesize when the model answers with text after using tools.
    AfterToolCandidate,
    /// Synthesize when the model answers with nothing after using tools.
    AfterToolEmpty,
    /// Synthesize after tool use whether the reply is empty or not.
    AfterAnyToolReply,
}

impl FinalSynthesis {
    /// Whether a reply of `text` (already trimmed) triggers synthesis.
    pub(super) fn applies_to(self, text: &str) -> bool {
        match self {
            Self::Never => false,
            Self::AfterToolCandidate => !text.is_empty(),
            Self::AfterToolEmpty => text.is_empty(),
            Self::AfterAnyToolReply => true,
        }
    }
}
