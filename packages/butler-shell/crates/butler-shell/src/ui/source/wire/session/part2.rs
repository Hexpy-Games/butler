//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AnswerBlockSet, CanonProposalAnchor, ChangedFileDetail, InitiatedOrigin,
    InterfaceContentReferences, MessageContent, MessageFileRef, PendingUserQuestionsQuestionState,
    PendingUserQuestionsQuestions, PlanDocumentRecord, ProgressDetailRow, ProviderAuthMethod,
    RuntimeDeliveryState, SessionArtifactSummary, TimelineEventPayloadTurnExecutionControls,
    TurnProgressSnapshot, UserQuestion, UserQuestionResponse, WorkBlockView,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:2048 PendingUserQuestions
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PendingUserQuestions {
    pub(crate) request_ref: String,
    pub(crate) source_turn_id: String,
    pub(crate) source_session_id: String,
    pub(crate) question_state: PendingUserQuestionsQuestionState,
    pub(crate) category: String,
    pub(crate) questions: PendingUserQuestionsQuestions,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2057 AnsweredUserQuestions (inline AnsweredUserQuestionsQuestions).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnsweredUserQuestionsQuestions {
    #[serde(default)]
    pub(crate) questions: Vec<UserQuestion>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2055 AnsweredUserQuestions
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnsweredUserQuestions {
    pub(crate) request_ref: String,
    pub(crate) source_turn_id: String,
    pub(crate) updated_at: String,
    pub(crate) questions: AnsweredUserQuestionsQuestions,
    pub(crate) response: UserQuestionResponse,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:9 ChatKind
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UiChatKind {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "project")]
    Project,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1104 SessionViewStatus
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionViewStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "delivered")]
    Delivered,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "idle")]
    Idle,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1134 SessionViewTurn (inline SessionViewTurnExecutionModel).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionViewTurnExecutionModel {
    pub(crate) requested_model_ref: String,
    pub(crate) adapter_effective_model_ref: String,
    #[serde(default)]
    pub(crate) provider_reported_model_ref: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1111 SessionViewTurn
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionViewTurn {
    pub(crate) id: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) safe_status_label: Option<String>,
    pub(crate) cancellable: bool,
    pub(crate) retryable: bool,
    #[serde(default)]
    pub(crate) delivery_state: Option<RuntimeDeliveryState>,
    #[serde(default)]
    pub(crate) limitation_codes: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) limitations: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) progress: Option<TurnProgressSnapshot>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) execution_controls: Option<TimelineEventPayloadTurnExecutionControls>,
    #[serde(default)]
    pub(crate) execution_model: Option<SessionViewTurnExecutionModel>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:920 MessageRecord (inline MessageRecordSystemEventKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageRecordSystemEventKind {
    #[serde(rename = "context.compaction.started")]
    ContextCompactionStarted,
    #[serde(rename = "context.compaction.completed")]
    ContextCompactionCompleted,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:925 MessageRecord (inline MessageRecordRole).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageRecordRole {
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

/// TS: packages/butler-app/client/ui/src/app/types.ts:947 MessageRecord (inline MessageRecordRetryMode).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageRecordRetryMode {
    #[serde(rename = "resume")]
    Resume,
    #[serde(rename = "fresh")]
    Fresh,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:912 MessageRecord
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct MessageRecord {
    #[serde(default)]
    pub(crate) canon_proposals: Option<Vec<CanonProposalAnchor>>,
    #[serde(default)]
    pub(crate) quiet: Option<bool>,
    #[serde(default)]
    pub(crate) failure_notice: Option<Box<MessageRecord>>,
    #[serde(default)]
    pub(crate) initiated: Option<InitiatedOrigin>,
    #[serde(default)]
    pub(crate) question_answer: Option<AnsweredUserQuestions>,
    #[serde(default)]
    pub(crate) question_summary: Option<Vec<UserQuestion>>,
    #[serde(default)]
    pub(crate) system_event_kind: Option<MessageRecordSystemEventKind>,
    #[serde(default)]
    pub(crate) content_parts: Option<MessageContent>,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) chat_id: Option<String>,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    pub(crate) role: MessageRecordRole,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) plan_document: Option<PlanDocumentRecord>,
    #[serde(default)]
    pub(crate) answer_blocks: Option<Vec<AnswerBlockSet>>,
    #[serde(default)]
    pub(crate) attachments: Option<Vec<MessageFileRef>>,
    #[serde(default)]
    pub(crate) artifacts: Option<Vec<SessionArtifactSummary>>,
    #[serde(default)]
    pub(crate) changed_files: Option<Vec<ChangedFileDetail>>,
    #[serde(default)]
    pub(crate) work_blocks: Option<Vec<WorkBlockView>>,
    #[serde(default)]
    pub(crate) turn_activity_rows: Option<Vec<ProgressRow>>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) delivery_state: Option<RuntimeDeliveryState>,
    #[serde(default)]
    pub(crate) limitation_codes: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) limitations: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) safe_error_code: Option<String>,
    #[serde(default)]
    pub(crate) retryable: Option<bool>,
    #[serde(default)]
    pub(crate) incomplete: Option<bool>,
    #[serde(default)]
    pub(crate) retry_mode: Option<MessageRecordRetryMode>,
    #[serde(default)]
    pub(crate) retry_with_current_controls: Option<bool>,
    #[serde(default)]
    pub(crate) cursor: Option<i64>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1043 ProgressRow (inline ProgressRowInterfaceLabelParameters).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProgressRowInterfaceLabelParameters {
    pub(crate) attempt: i64,
    pub(crate) maxAttempts: i64,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1059 ProgressRow (inline ProgressRowWorkBlockPhase).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProgressRowWorkBlockPhase {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "started")]
    Started,
    #[serde(rename = "updated")]
    Updated,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1023 ProgressRow
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProgressRow {
    #[serde(default)]
    pub(crate) action_key: Option<String>,
    #[serde(default)]
    pub(crate) failure_code: Option<String>,
    #[serde(default)]
    pub(crate) auth_type: Option<ProviderAuthMethod>,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    pub(crate) state: String,
    pub(crate) safe_label: String,
    #[serde(default)]
    pub(crate) turn_event_sequence: Option<i64>,
    #[serde(default)]
    pub(crate) safe_tool_name: Option<String>,
    #[serde(default)]
    pub(crate) safe_input_label: Option<String>,
    #[serde(default)]
    pub(crate) tool_call_id: Option<String>,
    #[serde(default)]
    pub(crate) thinking_title: Option<String>,
    #[serde(default)]
    pub(crate) thinking_body: Option<String>,
    #[serde(default)]
    pub(crate) tool_result_id: Option<String>,
    #[serde(default)]
    pub(crate) tool_result_byte_length: Option<i64>,
    #[serde(default)]
    pub(crate) bridge_phase: Option<String>,
    #[serde(default)]
    pub(crate) interface_label_key: Option<String>,
    #[serde(default)]
    pub(crate) interface_content: Option<InterfaceContentReferences>,
    #[serde(default)]
    pub(crate) interface_label_parameters: Option<ProgressRowInterfaceLabelParameters>,
    #[serde(default)]
    pub(crate) receipt_kind: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_role: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_summary: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_rationale: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_next_step: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_source: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_model_call_id: Option<String>,
    #[serde(default)]
    pub(crate) public_decision_latency_ms: Option<i64>,
    #[serde(default)]
    pub(crate) public_decision_evidence_refs: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) work_contract_id: Option<String>,
    #[serde(default)]
    pub(crate) work_stream_id: Option<String>,
    #[serde(default)]
    pub(crate) semantic_block_id: Option<String>,
    #[serde(default)]
    pub(crate) activity_stage: Option<String>,
    #[serde(default)]
    pub(crate) work_block_id: Option<String>,
    #[serde(default)]
    pub(crate) work_block_label: Option<String>,
    #[serde(default)]
    pub(crate) work_block_phase: Option<ProgressRowWorkBlockPhase>,
    #[serde(default)]
    pub(crate) work_block_sequence: Option<i64>,
    #[serde(default)]
    pub(crate) work_decision_id: Option<String>,
    #[serde(default)]
    pub(crate) work_decision_title: Option<String>,
    #[serde(default)]
    pub(crate) work_decision_summary: Option<String>,
    #[serde(default)]
    pub(crate) work_decision_rationale: Option<String>,
    #[serde(default)]
    pub(crate) work_decision_next_step: Option<String>,
    #[serde(default)]
    pub(crate) work_decision_source: Option<String>,
    #[serde(default)]
    pub(crate) work_decision_evidence_refs: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) runtime_fault_id: Option<String>,
    #[serde(default)]
    pub(crate) runtime_fault_kind: Option<String>,
    #[serde(default)]
    pub(crate) runtime_fault_retryable: Option<bool>,
    #[serde(default)]
    pub(crate) runtime_fault_public_summary: Option<String>,
    #[serde(default)]
    pub(crate) runtime_fault_safe_error_code: Option<String>,
    #[serde(default)]
    pub(crate) runtime_fault_safe_cause: Option<String>,
    #[serde(default)]
    pub(crate) safe_path_labels: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) safe_detail_rows: Option<Vec<ProgressDetailRow>>,
    #[serde(default)]
    pub(crate) safe_order: Option<i64>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
}
