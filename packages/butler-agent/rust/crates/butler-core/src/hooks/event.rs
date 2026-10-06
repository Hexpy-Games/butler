//! Version-one full-content lifecycle envelopes.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
/// Phase-one event names, compatible with Claude Code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEvent {
    /// Published session.
    SessionStart,
    /// Input admission before queue reservation.
    UserPromptSubmit,
    /// Valid tool call before authority.
    PreToolUse,
    /// Final tool result.
    PostToolUse,
    /// Accepted parent answer.
    Stop,
    /// Accepted child answer.
    SubagentStop,
}
impl HookEvent {
    /// Whether explicit decisions can block this event.
    pub fn blocks(self) -> bool {
        matches!(
            self,
            Self::UserPromptSubmit | Self::PreToolUse | Self::Stop | Self::SubagentStop
        )
    }
    /// Whether a tool matcher is valid.
    pub fn tool_event(self) -> bool {
        matches!(self, Self::PreToolUse | Self::PostToolUse)
    }
    /// Compact enabled-event bit for the idle fast path.
    pub fn bit(self) -> u8 {
        1 << (self as u8)
    }
}
/// Full-content payload; fields inapplicable to an event are omitted.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HookPayload {
    /// created or branched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Exact submitted prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Submitted attachment metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<HookAttachment>>,
    /// Exact tool name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Stable tool call identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Passthrough: full tool arguments, defined by the selected tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Map<String, Value>>,
    /// Whether authority resumed this call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed: Option<bool>,
    /// Final result success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    /// Passthrough: full tool response, defined by the selected tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_response: Option<crate::json::JsonDocument>,
    /// Final tool error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HookToolError>,
    /// Exact accepted answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
    /// Previous Stop hook requested continuation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_hook_active: Option<bool>,
}
/// Attachment metadata, never gateway credentials.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookAttachment {
    /// Display filename.
    pub name: String,
    /// MIME media type.
    pub media_type: String,
    /// Byte size.
    pub bytes: u64,
}
/// Model-facing failure details.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookToolError {
    /// Machine-readable code.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
}
/// Envelope shared by all command handlers; dispatcher adds hook identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookEnvelope {
    /// butler.hook.v1.
    pub schema: String,
    /// Lifecycle name.
    pub hook_event_name: HookEvent,
    /// Stable across retries/resumes.
    pub event_id: String,
    /// ISO timestamp.
    pub occurred_at: String,
    /// Runtime session identity, absent for tests.
    pub session_id: Option<String>,
    /// Turn identity where applicable.
    pub turn_id: Option<String>,
    /// Child session's parent where applicable.
    pub parent_session_id: Option<String>,
    /// Bound absolute project root, otherwise null.
    pub project_dir: Option<String>,
    /// Effective process working directory.
    pub cwd: String,
    /// Current permission mode, never modified by hooks.
    pub access_mode: Option<String>,
    /// Event-specific content.
    #[serde(flatten)]
    pub payload: HookPayload,
}
