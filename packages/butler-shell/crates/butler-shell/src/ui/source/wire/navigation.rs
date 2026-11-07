//! Typed renderer wire contracts; field names follow their TypeScript sources.
use super::SubtaskView;
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:58 NavigationView (inline NavigationViewAutomationsSummary).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NavigationViewAutomationsSummary {
    pub(crate) total_count: i64,
    pub(crate) enabled_count: i64,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:59 NavigationView (inline NavigationViewSettingsSummary).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NavigationViewSettingsSummary {
    pub(crate) profile_label: String,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:54 NavigationView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NavigationView {
    #[serde(default)]
    pub(crate) archive_count: i64,
    pub(crate) space: SpaceView,
    #[serde(default)]
    pub(crate) chats: Vec<SessionSummary>,
    #[serde(default)]
    pub(crate) projects: Vec<ProjectSummary>,
    pub(crate) automations_summary: NavigationViewAutomationsSummary,
    pub(crate) settings_summary: NavigationViewSettingsSummary,
    pub(crate) generated_at: String,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:180 ProjectSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProjectSummary {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) status: ProjectStatus,
    pub(crate) last_activity_at: String,
    pub(crate) active_session_count: i64,
    pub(crate) pinned: bool,
    pub(crate) archived: bool,
    #[serde(default)]
    pub(crate) error_summary: Option<String>,
    pub(crate) workspace_label: String,
    pub(crate) safe_path_label: String,
    #[serde(default)]
    pub(crate) sessions: Option<Vec<SessionSummary>>,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:144 ChatSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ChatSummary {
    #[serde(default)]
    pub(crate) epic_ids: Option<Vec<String>>,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) kind: ChatKind,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:156 SessionSummary (inline SessionSummaryWorkProgress).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionSummaryWorkProgress {
    pub(crate) completed: i64,
    pub(crate) total: i64,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:162 SessionSummary (inline SessionSummaryProject).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionSummaryProject {
    pub(crate) id: String,
    pub(crate) display_name: String,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:171 SessionSummary (inline SessionSummarySafeStatusLabelParameters).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionSummarySafeStatusLabelParameters {
    pub(crate) attempt: i64,
    pub(crate) maxAttempts: i64,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:154 SessionSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent SessionSummary wire fields mirror TypeScript"
)]
pub(crate) struct SessionSummary {
    #[serde(default)]
    pub(crate) running_delegated_work: bool,
    #[serde(default)]
    pub(crate) attention_required: bool,
    #[serde(default)]
    pub(crate) attention_source: Option<String>,
    #[serde(default)]
    pub(crate) subtasks: Vec<SubtaskView>,
    #[serde(default)]
    pub(crate) epic_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) work_progress: Option<SessionSummaryWorkProgress>,
    #[serde(default)]
    pub(crate) branch_seed: Option<SessionBranchSeed>,
    pub(crate) id: String,
    pub(crate) kind: ChatKind,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) project: Option<SessionSummaryProject>,
    #[serde(default)]
    pub(crate) session_hint: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) last_activity_at: String,
    #[serde(default)]
    pub(crate) last_message_preview: Option<String>,
    #[serde(default)]
    pub(crate) active_turn_state: Option<TurnState>,
    #[serde(default)]
    pub(crate) safe_status_label: Option<String>,
    #[serde(default)]
    pub(crate) safe_status_label_key: Option<String>,
    #[serde(default)]
    pub(crate) safe_status_label_parameters: Option<SessionSummarySafeStatusLabelParameters>,
    #[serde(default)]
    pub(crate) safe_status_content: Option<InterfaceContentReferences>,
    #[serde(default)]
    pub(crate) unread: bool,
    pub(crate) pinned: bool,
    pub(crate) archived: bool,
    #[serde(default)]
    pub(crate) automation_target_count: i64,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:27 SpaceView (inline SpaceViewSmartNotice).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpaceViewSmartNotice {
    pub(crate) title: String,
    pub(crate) undoToken: String,
    pub(crate) revision: i64,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:26 SpaceView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpaceView {
    #[serde(default)]
    pub(crate) smartNotice: Option<SpaceViewSmartNotice>,
    pub(crate) revision: i64,
    #[serde(default)]
    pub(crate) nodes: Vec<SpaceNode>,
    #[serde(default)]
    pub(crate) groups: Vec<SpaceGroup>,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:12 ProjectStatus
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "archived")]
    Archived,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:11 ChatKind
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChatKind {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "project")]
    Project,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:39 SessionBranchSeed
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionBranchSeed {
    pub(crate) summary: String,
    pub(crate) sourceSessionId: String,
    pub(crate) sourceMessageId: String,
    #[serde(default)]
    pub(crate) canonicalSessionId: Option<String>,
    #[serde(default)]
    pub(crate) canonicalMessageId: Option<String>,
    pub(crate) sourceThroughMessageId: String,
    pub(crate) excerptTruncated: bool,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:13 TurnState
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnState {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "accepted")]
    Accepted,
    #[serde(rename = "thinking")]
    Thinking,
    #[serde(rename = "streaming")]
    Streaming,
    #[serde(rename = "waiting_for_form")]
    WaitingForForm,
    #[serde(rename = "waiting_for_tool")]
    WaitingForTool,
    #[serde(rename = "cancelling")]
    Cancelling,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "delivered")]
    Delivered,
    #[serde(rename = "runtime_fault")]
    RuntimeFault,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "session_starting")]
    SessionStarting,
    #[serde(rename = "retrying")]
    Retrying,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-i18n/src/copy-contract.ts:2314 InterfaceContentReferences
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct InterfaceContentReferences {
    #[serde(default)]
    pub(crate) title: Option<InterfaceTextReference>,
    #[serde(default)]
    pub(crate) summary: Option<InterfaceTextReference>,
    #[serde(default)]
    pub(crate) nextStep: Option<InterfaceTextReference>,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:10 SpaceNode (inline SpaceNodeKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SpaceNodeKind {
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "group")]
    Group,
    #[serde(rename = "session")]
    Session,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:8 SpaceNode
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpaceNode {
    pub(crate) key: String,
    pub(crate) kind: SpaceNodeKind,
    pub(crate) entityId: String,
    #[serde(default)]
    pub(crate) parentKey: Option<String>,
    pub(crate) position: i64,
    pub(crate) revision: i64,
    pub(crate) manualPlacement: bool,
    #[serde(default)]
    pub(crate) scopeProjectId: Option<String>,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:23 SpaceGroup (inline SpaceGroupOrigin).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SpaceGroupOrigin {
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "smart")]
    Smart,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:19 SpaceGroup
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpaceGroup {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) scopeProjectId: Option<String>,
    pub(crate) origin: SpaceGroupOrigin,
}

/// TS: packages/butler-i18n/src/copy-contract.ts:2310 InterfaceTextReference (inline InterfaceTextReferenceKey).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InterfaceTextReferenceKey {
    #[serde(rename = "workerStatus")]
    WorkerStatus,
    #[serde(rename = "toolTitle")]
    ToolTitle,
    #[serde(rename = "checkingPrevious")]
    CheckingPrevious,
    #[serde(rename = "checkingRequest")]
    CheckingRequest,
    #[serde(rename = "toolWorking")]
    ToolWorking,
    #[serde(rename = "checkingInformation")]
    CheckingInformation,
    #[serde(rename = "commandExecuting")]
    CommandExecuting,
    #[serde(rename = "conceptionTitle")]
    ConceptionTitle,
    #[serde(rename = "planningNext")]
    PlanningNext,
    #[serde(rename = "reportTitle")]
    ReportTitle,
    #[serde(rename = "conceptionSummary")]
    ConceptionSummary,
    #[serde(rename = "workInProgress")]
    WorkInProgress,
    #[serde(rename = "toolsSummary")]
    ToolsSummary,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-i18n/src/copy-contract.ts:2311 InterfaceTextReference (inline InterfaceTextReferenceParametersToolsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct InterfaceTextReferenceParametersToolsItem {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) target: Option<String>,
}

/// TS: packages/butler-i18n/src/copy-contract.ts:2311 InterfaceTextReference (inline InterfaceTextReferenceParameters).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct InterfaceTextReferenceParameters {
    #[serde(default)]
    pub(crate) phase: Option<String>,
    #[serde(default)]
    pub(crate) toolName: Option<String>,
    #[serde(default)]
    pub(crate) target: Option<String>,
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) tools: Option<Vec<InterfaceTextReferenceParametersToolsItem>>,
}

/// TS: packages/butler-i18n/src/copy-contract.ts:2309 InterfaceTextReference
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct InterfaceTextReference {
    pub(crate) key: InterfaceTextReferenceKey,
    #[serde(default)]
    pub(crate) parameters: Option<InterfaceTextReferenceParameters>,
}
