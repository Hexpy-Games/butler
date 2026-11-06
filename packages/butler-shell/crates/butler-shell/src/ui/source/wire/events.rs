//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{MessageRecord, ProgressRow, ReasoningEffort};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1127 SessionViewTurn (inline TimelineEventPayloadTurnExecutionControlsSource).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TimelineEventPayloadTurnExecutionControlsSource {
    #[serde(rename = "message_override")]
    MessageOverride,
    #[serde(rename = "session_override")]
    SessionOverride,
    #[serde(rename = "global_default")]
    GlobalDefault,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1128 SessionViewTurn (inline TimelineEventPayloadTurnExecutionControlsSubsessionResult).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TimelineEventPayloadTurnExecutionControlsSubsessionResult {
    pub(crate) relation_id: String,
    pub(crate) result_id: String,
    pub(crate) safe_title: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1801 TimelineEvent (inline TimelineEventPayloadTurnExecutionControls).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TimelineEventPayloadTurnExecutionControls {
    pub(crate) model_ref: String,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) source: TimelineEventPayloadTurnExecutionControlsSource,
    #[serde(default)]
    pub(crate) subsession_result: Option<TimelineEventPayloadTurnExecutionControlsSubsessionResult>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1795 TimelineEvent (inline TimelineEventPayloadTurn).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TimelineEventPayloadTurn {
    pub(crate) id: String,
    pub(crate) chat_id: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) safe_status_label: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) execution_controls: Option<TimelineEventPayloadTurnExecutionControls>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1805 TimelineEvent (inline TimelineEventPayloadRole).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TimelineEventPayloadRole {
    #[serde(rename = "automation")]
    Automation,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "assistant")]
    Assistant,
    #[serde(rename = "system")]
    System,
    #[serde(rename = "system_event")]
    SystemEvent,
    #[serde(rename = "tool_summary")]
    ToolSummary,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1791 TimelineEvent (inline TimelineEventPayload).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TimelineEventPayload {
    #[serde(default)]
    pub(crate) progress: Option<UpdateProgressView>,
    #[serde(default)]
    pub(crate) message: Option<MessageRecord>,
    #[serde(default)]
    pub(crate) segment_completed: Option<bool>,
    #[serde(default)]
    pub(crate) turn: Option<TimelineEventPayloadTurn>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
    #[serde(default)]
    pub(crate) chat_id: Option<String>,
    #[serde(default)]
    pub(crate) role: Option<TimelineEventPayloadRole>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) child_session_id: Option<String>,
    #[serde(default)]
    pub(crate) session: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) state: Option<String>,
    #[serde(default)]
    pub(crate) safe_status_label: Option<String>,
    #[serde(default)]
    pub(crate) row: Option<ProgressRow>,
    #[serde(default)]
    pub(crate) event: Option<AgentTurnEvent>,
    #[serde(default)]
    pub(crate) event_id: Option<String>,
    #[serde(default)]
    pub(crate) settings: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) round_id: Option<String>,
    #[serde(default)]
    pub(crate) stream_id: Option<String>,
    #[serde(default)]
    pub(crate) line: Option<String>,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) tainted: Option<bool>,
    #[serde(default)]
    pub(crate) site: Option<String>,
    #[serde(default)]
    pub(crate) amount: Option<String>,
    #[serde(default)]
    pub(crate) target_session_id: Option<String>,
    #[serde(default)]
    pub(crate) safe_error_code: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1787 TimelineEvent
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TimelineEvent {
    #[serde(default)]
    pub(crate) id: Option<i64>,
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) payload: Option<TimelineEventPayload>,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:354 AppEventEnvelope
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AppEventEnvelope {
    pub(crate) protocol_version: String,
    pub(crate) id: i64,
    pub(crate) r#type: String,
    pub(crate) created_at: String,
    pub(crate) payload: serde_json::Value,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:481 UpdateProgressView (inline UpdateProgressViewStage).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateProgressViewStage {
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "verifying")]
    Verifying,
    #[serde(rename = "checking")]
    Checking,
    #[serde(rename = "downloading")]
    Downloading,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "applying")]
    Applying,
    #[serde(rename = "restarting")]
    Restarting,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:479 UpdateProgressView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct UpdateProgressView {
    pub(crate) component: UpdateComponentId,
    pub(crate) stage: UpdateProgressViewStage,
    pub(crate) revision: i64,
    #[serde(default)]
    pub(crate) bytes_done: Option<i64>,
    #[serde(default)]
    pub(crate) bytes_per_second: Option<i64>,
    #[serde(default)]
    pub(crate) bytes_total: Option<i64>,
    pub(crate) cancellable: bool,
    #[serde(default)]
    pub(crate) error_code: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1362 AgentTurnEvent (inline AgentTurnEventVisibility).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentTurnEventVisibility {
    #[serde(rename = "public")]
    Public,
    #[serde(rename = "internal")]
    Internal,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1354 AgentTurnEvent
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AgentTurnEvent {
    pub(crate) id: String,
    pub(crate) sessionId: String,
    pub(crate) turnId: String,
    pub(crate) sessionSequence: i64,
    pub(crate) turnSequence: i64,
    #[serde(default)]
    pub(crate) createdAt: Option<String>,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) visibility: Option<AgentTurnEventVisibility>,
    #[serde(default)]
    pub(crate) payload: Option<serde_json::Value>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:422 UpdateComponentId
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateComponentId {
    #[serde(rename = "service")]
    Service,
    #[serde(rename = "app")]
    App,
    #[serde(other)]
    Unknown,
}
