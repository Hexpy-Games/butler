//! Required composition ports and owned App transport values.

use super::sessions::{
    AppSessionWorkProgress, AppSessionWorkspaceProvisioner, AppWorkStreamReader,
};
use crate::btcc::ReasoningEffort;
use crate::gateway::{
    ApplicationFuture, GatewayApplicationError, MessageFileRef, ProjectSourceReference,
    RuntimeReadinessView,
};
use bytes::Bytes;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct NativeAppTurn {
    pub chat_id: String,
    pub message_id: String,
    pub turn_id: String,
    pub turn_attempt: u64,
    pub text: String,
    pub timestamp: String,
    pub session_id: String,
    pub account_id: String,
    pub peer_kind: String,
    pub sender_id: String,
    pub sender_display_name: String,
    pub project_id: Option<String>,
    pub execution_controls: Value,
    pub app_queue_claim_id: Option<String>,
    pub app_turn_context: Value,
    pub attachments: Value,
    pub image_admission: Option<Value>,
    pub raw_source: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeEnqueueReceipt {
    pub queue_id: String,
}

pub(crate) trait AppNativeIngress: Send + Sync + 'static {
    fn enqueue(&self, turn: NativeAppTurn) -> ApplicationFuture<NativeEnqueueReceipt>;
    fn find(&self, turn: NativeAppTurn) -> ApplicationFuture<Option<NativeEnqueueReceipt>>;
    fn enqueue_cancel(
        &self,
        _cancel: NativeAppCancellation,
    ) -> ApplicationFuture<NativeEnqueueReceipt> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NativeAppCancellation {
    pub chat_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub request_id: String,
    pub requested_at: String,
    pub app_queue_claim_id: Option<String>,
}
pub(crate) trait AppNativeAssetResolver: Send + Sync + 'static {
    fn resolve(&self, snapshot: ClaimedNativeSnapshot) -> ApplicationFuture<ResolvedNativeAssets>;
}
pub(crate) trait AppExecutorReadiness: Send + Sync + 'static {
    fn readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError>;
}
pub(crate) trait AppAdmissionAuthority: Send + Sync + 'static {
    fn read_ledger_source(
        &self,
        request: AppLedgerSourceRequest,
    ) -> ApplicationFuture<AppSourceDocument>;
    fn snapshot_source(
        &self,
        request: AppSourceSnapshotRequest,
    ) -> ApplicationFuture<MaterializedResponderFile>;
    fn admit_visual(&self, request: VisualAdmissionRequest) -> ApplicationFuture<Value>;
}
pub(crate) trait AppArtifactMaterializer: Send + Sync + 'static {
    fn materialize(
        &self,
        request: ArtifactMaterializationRequest,
    ) -> ApplicationFuture<Vec<MaterializedResponderFile>>;
}
pub(crate) trait AppMessageFileStorage: Send + Sync + 'static {
    fn write_upload(&self, input: AppFileWrite) -> ApplicationFuture<MaterializedResponderFile>;
    fn prepare_uploaded(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<()>;
    fn read_original(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<Bytes>;
}
pub(crate) trait AppSettingsFactsProvider: Send + Sync + 'static {
    /// Returns an immutable snapshot prepared by the native config and model owners.
    /// This call must not enter App SQLite, perform I/O, or wait on async work.
    fn snapshot(&self) -> Result<Arc<AppSettingsFacts>, GatewayApplicationError>;
    fn refresh(&self) -> ApplicationFuture<()>;
}
pub(crate) trait AppSettingsMutationPort: Send + Sync + 'static {
    fn apply(&self, patch: Value, projection: Value) -> ApplicationFuture<()>;
}
pub(crate) trait AppRuntimeInfoProvider: Send + Sync + 'static {
    fn app_version(&self) -> Result<String, GatewayApplicationError>;
}
pub(crate) trait AppIdentityClock: Send + Sync + 'static {
    fn new_uuid(&self) -> String;
    fn now_iso(&self) -> String;
    fn iso_after_millis(&self, millis: u64) -> String;
}
pub(crate) trait AppApprovalClaims: Send + Sync + 'static {
    fn retains_claim(&self, turn_id: String) -> ApplicationFuture<bool>;
}
pub(crate) trait AppQueueOwnerLiveness: Send + Sync + 'static {
    fn definitely_dead(&self, owner: &str, current_owner: &str) -> bool;
}

#[derive(Clone, Debug)]
pub(crate) struct AppBranchCanonicalAnswer {
    pub session_id: String,
    pub turn_id: String,
    pub message_id: String,
}

pub(crate) trait AppBranchConversationReader: Send + Sync + 'static {
    fn resolve_app_session(&self, id: String) -> ApplicationFuture<Option<(String, String)>>;
    fn answer(&self, message_id: String) -> ApplicationFuture<Option<AppBranchCanonicalAnswer>>;
    fn context(&self, session_id: String, message_id: String) -> ApplicationFuture<Option<String>>;
}

#[derive(Clone, Debug)]
pub(crate) struct AppBranchSummaryInput {
    pub text: String,
    pub model_ref: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppBranchSummary {
    pub text: String,
    pub excerpt_truncated: bool,
}

pub(crate) trait AppBranchSummarizer: Send + Sync + 'static {
    fn summarize(
        &self,
        input: AppBranchSummaryInput,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<AppBranchSummary>;
}

#[derive(Clone, Debug)]
pub(crate) struct AppAuthorityPage {
    pub requests: Vec<Value>,
    pub permissions: Vec<Value>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppAuthorityDecision {
    pub request_ref: String,
    pub decision: String,
    pub admitted: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AppAuthorityDecisionInput {
    pub owner_session_id: String,
    pub request_ref: String,
    pub action: String,
    pub allow_scope: Option<String>,
    pub alternative_input: Option<String>,
}

pub(crate) trait AppAuthorityHandoff: Send + Sync + 'static {
    fn list(&self, owner_session_id: String) -> ApplicationFuture<AppAuthorityPage>;
    fn revoke(&self, owner_session_id: String, grant_ref: String) -> ApplicationFuture<()>;
    fn decide(&self, input: AppAuthorityDecisionInput) -> ApplicationFuture<AppAuthorityDecision>;
    fn retry_decided(&self) -> ApplicationFuture<()>;
    fn close_self_session(
        &self,
        runtime_session_id: String,
        reason: String,
    ) -> ApplicationFuture<()>;
}

pub(crate) struct PreparedAppAdmission {
    pub text: String,
    pub attachments: Value,
    pub admission_identity: Value,
    pub project_sources: Value,
}
#[derive(Clone, Debug)]
pub(crate) struct AppChatSnapshot {
    pub id: String,
    pub project_id: Option<String>,
    pub archived: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AppMessageFileSnapshot {
    pub id: String,
    pub owner_session_id: Option<String>,
    pub message_id: Option<String>,
    pub kind: String,
    pub mime_type: String,
    pub safe_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub storage_name: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppFileUpload {
    pub owner_session_id: Option<String>,
    pub name: String,
    pub mime_type: Option<String>,
    pub bytes: Bytes,
}

#[derive(Clone, Debug)]
pub(crate) struct AppFileWrite {
    pub name: String,
    pub mime_type: Option<String>,
    pub bytes: Bytes,
}

pub(crate) struct AppFileDownload {
    pub file: MessageFileRef,
    pub bytes: Bytes,
}

#[derive(Clone, Debug)]
pub(crate) struct AppLedgerSourceRequest {
    pub project: NativeProjectSnapshot,
    pub source: ProjectSourceReference,
}

#[derive(Clone, Debug)]
pub(crate) struct AppSourceDocument {
    pub title: String,
    pub body: String,
    pub revision: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppSourceSnapshotRequest {
    pub name: String,
    pub body: String,
}
#[derive(Clone, Debug)]
pub(crate) struct VisualAdmissionRequest {
    pub model_ref: String,
    pub files: Vec<AppMessageFileSnapshot>,
}
pub(crate) struct AppApplicationDependencies {
    pub updates: Arc<crate::operations::AppUpdateService>,
    pub skills: Arc<crate::skills::NativeSkills>,
    pub mcp_client: Arc<crate::mcp_client::NativeMcpClient>,
    pub native_ingress: Arc<dyn AppNativeIngress>,
    pub native_assets: Arc<dyn AppNativeAssetResolver>,
    pub executor_readiness: Arc<dyn AppExecutorReadiness>,
    pub admission: Arc<dyn AppAdmissionAuthority>,
    pub artifact_materializer: Arc<dyn AppArtifactMaterializer>,
    pub message_files: Arc<dyn AppMessageFileStorage>,
    pub settings_facts: Arc<dyn AppSettingsFactsProvider>,
    pub settings_mutations: Arc<dyn AppSettingsMutationPort>,
    pub runtime_info: Arc<dyn AppRuntimeInfoProvider>,
    pub model_catalog: Arc<dyn super::AppModelCatalogPort>,
    pub personalization: Arc<dyn super::AppPersonalizationPort>,
    pub monitoring: Arc<dyn super::AppMonitoringPort>,
    pub project_dashboard_ledger: Arc<dyn super::AppProjectDashboardLedgerPort>,
    pub plan_decision_ledger: Arc<dyn super::AppPlanDecisionLedgerPort>,
    pub project_dashboard_briefing: Arc<dyn super::AppProjectDashboardBriefingPort>,
    pub relocation_host: Arc<dyn super::AppRelocationHost>,
    pub context_read: Arc<dyn AppContextReadPort>,
    pub identity_clock: Arc<dyn AppIdentityClock>,
    pub approval_claims: Arc<dyn AppApprovalClaims>,
    pub queue_owner_liveness: Arc<dyn AppQueueOwnerLiveness>,
    pub authority_handoff: Arc<dyn AppAuthorityHandoff>,
    pub session_workspaces: Arc<dyn AppSessionWorkspaceProvisioner>,
    pub session_work_progress: Arc<dyn AppSessionWorkProgress>,
    pub work_streams: Arc<dyn AppWorkStreamReader>,
    pub subsessions: Arc<dyn AppSubsessionPort>,
    pub branch_conversations: Arc<dyn AppBranchConversationReader>,
    pub branch_summarizer: Arc<dyn AppBranchSummarizer>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppContextReadQuery {
    pub runtime_session_id: String,
    pub turn_id: Option<String>,
    pub latest_turn_started_at_ms: Option<i64>,
    pub model_ref: String,
    pub context_window_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppContextUsage {
    pub prompt_tokens: u64,
    pub source: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppContextBudgetFacts {
    pub context_window_tokens: u64,
    pub reserved_output_tokens: u64,
    pub reserved_tool_tokens: u64,
    pub compaction_prompt_reserve_tokens: u64,
    pub max_output_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppContextReadFacts {
    pub usage: Option<AppContextUsage>,
    pub compaction_summary: Option<String>,
    pub budget: AppContextBudgetFacts,
}

pub(crate) trait AppContextReadPort: Send + Sync {
    fn read(&self, query: AppContextReadQuery) -> ApplicationFuture<AppContextReadFacts>;
}

pub(crate) trait AppSubsessionPort: Send + Sync {
    fn projection(
        &self,
        session_id: String,
        page: Option<AppSessionViewPage>,
    ) -> ApplicationFuture<Value>;
    fn cancel(&self, parent_session_id: String, relation_id: String) -> ApplicationFuture<Value>;
    fn resume(&self, parent_session_id: String, relation_id: String) -> ApplicationFuture<Value>;
    fn read_operation_output_chunks(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
    ) -> ApplicationFuture<Vec<super::operation_output::OperationOutputChunk>>;
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppSessionViewPage {
    pub after_cursor: Option<u64>,
    pub before_cursor: Option<u64>,
    pub limit: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct AppSettingsFacts {
    pub registered_models: Arc<[AppModelMetadata]>,
    pub known_models: Arc<[AppModelMetadata]>,
    pub config_default_model: Option<String>,
    pub config_model_fallback: AppModelFallbackFacts,
    pub catalog_generation: String,
    /// Non-secret configuration-backed Settings values projected by Host.
    pub native_settings: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AppModelMetadata {
    pub provider_id: String,
    pub provider_family_id: Option<String>,
    pub model_id: String,
    pub model_ref: String,
    pub context_window_tokens: Option<u64>,
    pub aliases: Arc<[String]>,
    pub runtime_supported: bool,
    pub registered: bool,
    pub enabled: bool,
    pub reasoning_efforts: Arc<[ReasoningEffort]>,
    pub default_reasoning_effort: ReasoningEffort,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct AppModelFallbackFacts {
    pub enabled: bool,
    pub models: Arc<[String]>,
}

#[derive(Clone, Debug)]
pub(crate) struct NativeProjectSnapshot {
    pub id: String,
    pub workspace_path: String,
    pub ledger_project_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ClaimedNativeSnapshot {
    pub chat_id: String,
    pub turn_id: String,
    pub message_id: String,
    pub turn_attempt: u64,
    pub text: String,
    pub timestamp: String,
    pub execution_controls: Value,
    pub app_queue_claim_id: Option<String>,
    pub session_id: String,
    pub session_kind: String,
    pub project: Option<NativeProjectSnapshot>,
    pub branch_seed: Option<Value>,
    pub project_sources: Value,
    pub content_parts: Option<crate::gateway::MessageContent>,
    pub authority_request_ref: Option<String>,
    pub plan_id: Option<String>,
    pub attached_files: Vec<AppMessageFileSnapshot>,
    pub queue_attachments: Value,
    pub reference_chats: Vec<AppReferencedChatSnapshot>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppReferencedChatSnapshot {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedNativeAssets {
    pub attachments: Value,
    pub image_admission: Option<Value>,
    pub session_references: Value,
}
pub(crate) struct AppApplicationConfig {
    pub database_path: PathBuf,
    pub butler_data: PathBuf,
    pub project_workspace_root: PathBuf,
    pub folder_selection_secret: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ArtifactMaterializationRequest {
    pub allowed_roots: Vec<PathBuf>,
    pub candidates: Vec<ArtifactFileCandidate>,
    pub existing_content_keys: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ArtifactFileCandidate {
    pub candidate_paths: Vec<PathBuf>,
    pub name: String,
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MaterializedResponderFile {
    pub id: String,
    pub kind: String,
    pub mime_type: String,
    pub safe_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub storage_name: String,
    pub created_at: String,
}
