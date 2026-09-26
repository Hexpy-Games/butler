//! Native App HTTP boundary.
//!
//! This module owns protocol validation, authentication, cursor projection, and
//! connection lifetimes. Durable message, Turn, and event state remains owned by
//! the required [`GatewayApplication`] implementation supplied at composition.

mod application;
mod auth;
mod http;
mod image_files;
mod live;
mod message_files;
mod message_validation;
mod mutations;
mod native_queue;
mod protocol;
mod rate_limit;
mod session_references;
mod transcript;

pub(crate) use mutations::GatewayMutationCommands;
use std::{future::Future, net::SocketAddr, pin::Pin, sync::Arc};

use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub(crate) use application::app_session_hint;
pub(crate) use application::diagnostics_enabled_readonly;
pub(crate) use application::normalize_committed_turn_event;
pub(crate) use application::{
    AppAdmissionAuthority, AppApplication, AppApplicationConfig, AppApplicationDependencies,
    AppApprovalClaims, AppArtifactMaterializer, AppAuthorityDecision, AppAuthorityDecisionInput,
    AppAuthorityHandoff, AppAuthorityPage, AppBoundWorkStatusFact, AppBranchCanonicalAnswer,
    AppBranchConversationReader, AppBranchSummarizer, AppBranchSummary, AppBranchSummaryInput,
    AppChatKind, AppChatSummary, AppContextBudgetFacts, AppContextReadFacts, AppContextReadPort,
    AppContextReadQuery, AppContextUsage, AppCreateProjectRequest, AppCreateProjectResult,
    AppCreateSessionInput, AppCreateSessionRequest, AppCreateSessionResult, AppDeveloperLogsQuery,
    AppExecutorReadiness, AppFileDownload, AppFileUpload, AppFileWrite, AppIdentityClock,
    AppLedgerSourceRequest, AppMessageFileSnapshot, AppMessageFileStorage, AppModelCatalogCommand,
    AppModelCatalogPort, AppModelFallbackFacts, AppModelMetadata, AppMonitorPage,
    AppMonitoringPort, AppNativeAssetResolver, AppNativeIngress, AppPersonalizationCommand,
    AppPersonalizationEvent, AppPersonalizationPort, AppPersonalizationResult,
    AppPlanDecisionAction, AppPlanDecisionLedgerError, AppPlanDecisionLedgerFuture,
    AppPlanDecisionLedgerPort, AppPlanDecisionPlan, AppPlanDecisionRequest, AppPlanDecisionResult,
    AppPlanDecisionStatus, AppProjectActionResult, AppProjectDashboardActionProgress,
    AppProjectDashboardBriefingPort, AppProjectDashboardBriefingPrompt,
    AppProjectDashboardBriefingRequest, AppProjectDashboardCheckpoint,
    AppProjectDashboardDisposition, AppProjectDashboardLedgerError, AppProjectDashboardLedgerEvent,
    AppProjectDashboardLedgerFuture, AppProjectDashboardLedgerHistory,
    AppProjectDashboardLedgerPort, AppProjectDashboardLedgerRecord, AppProjectDashboardManagedPlan,
    AppProjectDashboardManagedWork, AppProjectDashboardPageQuery, AppProjectDashboardPinRef,
    AppProjectDashboardPreferencesUpdate, AppProjectDashboardRecordsQuery,
    AppProjectDashboardReview, AppProjectDashboardSnapshot, AppProjectDashboardSource,
    AppProjectDashboardSourceQuery, AppProjectDashboardStatisticsQuery, AppProjectDashboardWork,
    AppProjectDashboardWorkHistoryEntry, AppProjectList, AppProjectSource, AppProjectUpdate,
    AppQueueOwnerLiveness, AppReferencedChatSnapshot, AppRelocateSessionRequest,
    AppRelocationBinding, AppRelocationBindingResult, AppRelocationBindingSeed,
    AppRelocationBindingUpdate, AppRelocationCanonicalUpdate, AppRelocationHost,
    AppRelocationSnapshot, AppRelocationTransportBinding, AppRelocationWorkspaceMarker,
    AppRelocationWorkspacePlan, AppRelocationWorkspaceRequest, AppRuntimeInfoProvider,
    AppSessionActionResult, AppSessionBranchQuery, AppSessionBranchResult, AppSessionControlUpdate,
    AppSessionControlsView, AppSessionSummary, AppSessionUpdate, AppSessionViewPage,
    AppSessionWorkProgress, AppSessionWorkspaceProvisioner, AppSessionWorkspaceSnapshot,
    AppSettingsFacts, AppSettingsFactsProvider, AppSettingsMutationPort, AppSourceDocument,
    AppSourceSnapshotRequest, AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin,
    AppStartTopicConversationRequest, AppSubsessionPort, AppUsageMonitorQuery,
    AppWorkOperationalNoticeFact, AppWorkProgress, AppWorkStatusConversationFact,
    AppWorkStreamQuery, AppWorkStreamReader, AppWorkStreamTurnOutcome, AppWorkerActivityQuery,
    AppWorkspaceMode, ArtifactFileCandidate, ArtifactMaterializationRequest, ClaimedNativeSnapshot,
    MaterializedResponderFile, NativeAppCancellation, NativeAppTurn, NativeEnqueueReceipt,
    NativeProjectSnapshot, OperationOutputChunk, OperationOutputView, ResolvedNativeAssets,
    TranscriptExport, VisualAdmissionRequest,
};
pub(crate) use application::{
    AutomationDetailView, AutomationListView, AutomationMutationResult, AutomationRunListView,
    AutomationRunResult, CreateAutomationRequest, UpdateAutomationRequest,
};
#[cfg(test)]
pub(crate) use application::{TestProjectDashboardBriefing, TestProjectDashboardLedger};
pub(crate) use application::{app_work_status, app_worker_activity};
pub(crate) use application::{read_new_chat_briefing_projects, read_new_chat_briefing_settings};
pub(crate) use auth::LocalAuthConfig;
pub(crate) use image_files::NativeAppImageFiles;
pub(crate) use message_files::NativeAppMessageFiles;
pub(crate) use native_queue::{
    ClaimedInboundEvent, NativeInboundQueue, NativeQueueError, QueuedInboundEvent,
};
pub(crate) use protocol::{
    AppEventEnvelope, ArtifactKind, ArtifactOpenAction, ChangedFileDetail, DeliveryState,
    EventReplayView, HealthView, MessageContent, MessageContentPart, MessageFileKind,
    MessageFileRef, MessageListView, MessageRecord, MessageRole, MessageSendRequest,
    MessageSendResult, MessageStatus, ProgressState, ProjectSourceReference, QueueState,
    QueuedMessageRecord, RuntimeReadinessView, SessionArtifactSummary, SessionControlState,
    SessionQueueUpdateRequest, SessionQueueView, TurnListView, TurnProgressSnapshotView,
    TurnRecord, TurnState,
};
pub(crate) use session_references::resolve_session_references;
pub(crate) use transcript::NativeTranscriptWriter;

pub(crate) type ApplicationFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, GatewayApplicationError>> + Send + 'static>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum GatewayApplicationError {
    Public {
        status: u16,
        code: String,
        message: String,
    },
    Internal,
}

pub(crate) struct SendMessageCommand {
    pub request: MessageSendRequest,
    pub chat_id: String,
}

/// Project dashboard HTTP operations, backed by the App and Project Ledger owners.
pub(crate) trait GatewayProjectDashboard: Send + Sync {
    fn get_project_dashboard(&self, project_id: String) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_records(
        &self,
        project_id: String,
        query: AppProjectDashboardRecordsQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_materials(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_history(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_artifacts(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_source(
        &self,
        project_id: String,
        query: AppProjectDashboardSourceQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_statistics(
        &self,
        project_id: String,
        query: AppProjectDashboardStatisticsQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn update_project_dashboard_preferences(
        &self,
        project_id: String,
        update: AppProjectDashboardPreferencesUpdate,
    ) -> ApplicationFuture<serde_json::Value>;
    fn request_project_dashboard_briefing(
        &self,
        project_id: String,
        request: AppProjectDashboardBriefingRequest,
    ) -> ApplicationFuture<serde_json::Value>;
    fn attach_project_dashboard_artifact(
        &self,
        project_id: String,
        artifact_id: String,
        revision: String,
    ) -> ApplicationFuture<MessageFileRef>;
}

/// Session controls and Plan decisions use the App revision and Project Ledger owners.
pub(crate) trait GatewaySessionControls: Send + Sync {
    fn get_session_controls_view(
        &self,
        session_id: String,
    ) -> ApplicationFuture<AppSessionControlsView>;
    fn update_session_controls_view(
        &self,
        session_id: String,
        update: AppSessionControlUpdate,
    ) -> ApplicationFuture<AppSessionControlsView>;
    fn decide_session_plan(
        &self,
        session_id: String,
        plan_id: String,
        request: AppPlanDecisionRequest,
    ) -> ApplicationFuture<AppPlanDecisionResult>;
}

/// The durable application operations consumed by the HTTP adapter.
///
/// Every method is required. Composition cannot replace absent persistence or
/// BTCC readiness with process-liveness guesses or an optional callback.
pub(crate) trait GatewayApplication:
    GatewayMutationCommands + GatewayProjectDashboard + GatewaySessionControls + Send + Sync + 'static
{
    fn check_app_update(
        &self,
        request: crate::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value>;
    fn apply_app_update(
        &self,
        request: crate::operations::UpdateRequest,
    ) -> ApplicationFuture<serde_json::Value>;
    fn list_skills(&self) -> ApplicationFuture<crate::skills::SkillSettingsView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn import_skill(
        &self,
        _archive: crate::skills::StagedSkillArchive,
        _project_id: Option<String>,
    ) -> ApplicationFuture<crate::skills::SkillImportResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn create_project(
        &self,
        request: AppCreateProjectRequest,
    ) -> ApplicationFuture<AppCreateProjectResult>;
    fn list_projects(&self, include_sessions: bool) -> ApplicationFuture<AppProjectList>;
    fn new_chat_briefing(
        &self,
        date: Option<String>,
        project_id: Option<String>,
    ) -> ApplicationFuture<serde_json::Value>;
    fn create_session(
        &self,
        request: AppCreateSessionRequest,
        server_shutdown: CancellationToken,
    ) -> ApplicationFuture<AppCreateSessionResult>;
    fn start_topic_conversation(
        &self,
        _request: AppStartTopicConversationRequest,
        _server_shutdown: CancellationToken,
    ) -> ApplicationFuture<AppSessionBranchResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_chats(&self) -> ApplicationFuture<Vec<AppChatSummary>>;
    fn read_navigation(&self) -> ApplicationFuture<serde_json::Value>;
    fn search_command_palette(&self, query: String) -> ApplicationFuture<serde_json::Value>;
    fn list_archives(
        &self,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_usage_monitor(
        &self,
        query: AppUsageMonitorQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>>;
    fn work_status_conversation(
        &self,
        chat_id: String,
    ) -> ApplicationFuture<AppWorkStatusConversationFact>;
    fn list_system_events(&self, page: AppMonitorPage) -> ApplicationFuture<serde_json::Value>;
    fn list_developer_logs(
        &self,
        query: AppDeveloperLogsQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn read_app_info(&self) -> ApplicationFuture<serde_json::Value>;
    fn model_catalog(
        &self,
        command: AppModelCatalogCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value>;
    fn personalization(
        &self,
        command: AppPersonalizationCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value>;
    fn list_sessions(
        &self,
        kind: Option<String>,
        project_id: Option<String>,
    ) -> ApplicationFuture<Vec<AppSessionSummary>>;
    fn list_automations(
        &self,
        target_session_id: Option<String>,
    ) -> ApplicationFuture<AutomationListView>;
    fn get_automation(&self, id: String) -> ApplicationFuture<AutomationDetailView>;
    fn create_automation(
        &self,
        request: CreateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult>;
    fn update_automation(
        &self,
        id: String,
        request: UpdateAutomationRequest,
    ) -> ApplicationFuture<AutomationMutationResult>;
    fn delete_automation(&self, id: String) -> ApplicationFuture<AutomationMutationResult>;
    fn run_automation(&self, id: String) -> ApplicationFuture<AutomationRunResult>;
    fn dispatch_due_automations(&self) -> ApplicationFuture<AutomationRunListView>;
    fn list_automation_runs(&self, id: String) -> ApplicationFuture<AutomationRunListView>;
    fn upload_message_file(&self, input: AppFileUpload) -> ApplicationFuture<MessageFileRef>;
    fn download_message_file(&self, id: String) -> ApplicationFuture<AppFileDownload>;
    fn runtime_readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError>;
    fn read_settings(&self) -> ApplicationFuture<serde_json::Value>;
    fn update_settings(&self, input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        let _ = input;
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_mcp_servers(&self) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn list_mcp_capabilities(
        &self,
        _shutdown: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn create_mcp_server(&self, _input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_mcp_server(
        &self,
        _id: String,
        _input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn delete_mcp_server(&self, _id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn probe_mcp_server(
        &self,
        _id: String,
        _shutdown: CancellationToken,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn send_message(&self, command: SendMessageCommand) -> ApplicationFuture<MessageSendResult>;
    fn authority_list(&self, owner_session_id: String) -> ApplicationFuture<AppAuthorityPage>;
    fn authority_revoke(
        &self,
        owner_session_id: String,
        grant_ref: String,
    ) -> ApplicationFuture<()>;
    fn authority_decide(
        &self,
        input: AppAuthorityDecisionInput,
    ) -> ApplicationFuture<AppAuthorityDecision>;
    fn refresh_message_projection(&self, chat_id: String) -> ApplicationFuture<()>;
    fn list_messages(
        &self,
        chat_id: String,
        after_cursor: f64,
        limit: usize,
    ) -> ApplicationFuture<MessageListView>;
    fn list_artifacts(&self, session_id: String) -> ApplicationFuture<Vec<SessionArtifactSummary>>;
    fn export_transcript(&self, session_id: String) -> ApplicationFuture<TranscriptExport>;
    fn list_session_queue(&self, session_id: String) -> ApplicationFuture<SessionQueueView>;
    fn create_session_queue(
        &self,
        request: MessageSendRequest,
    ) -> ApplicationFuture<SessionQueueView>;
    fn update_session_queue(
        &self,
        queued_message_id: String,
        request: SessionQueueUpdateRequest,
    ) -> ApplicationFuture<SessionQueueView>;
    fn delete_session_queue(
        &self,
        queued_message_id: String,
    ) -> ApplicationFuture<SessionQueueView>;
    fn list_turns(&self, chat_id: String, after_cursor: f64) -> ApplicationFuture<TurnListView>;
    fn get_operation_output(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
        byte_start: u64,
    ) -> ApplicationFuture<Option<OperationOutputView>>;
    fn cancel_turn(&self, _turn_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn retry_turn(&self, turn_id: String) -> ApplicationFuture<serde_json::Value>;
    fn retry_turn_with_current_controls(
        &self,
        turn_id: String,
    ) -> ApplicationFuture<MessageSendResult>;
    fn subsession_projection(&self, _session_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn session_view(
        &self,
        _session_id: String,
        _page: AppSessionViewPage,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn session_summary_view(&self, _session_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn context_details(&self, _session_id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn cancel_subsession(
        &self,
        _parent_session_id: String,
        _relation_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn resume_subsession(
        &self,
        _parent_session_id: String,
        _relation_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn latest_event_cursor(&self) -> ApplicationFuture<u64>;
    fn replay_events(
        &self,
        after_cursor: f64,
        limit: usize,
    ) -> ApplicationFuture<Vec<AppEventEnvelope>>;
    fn subscribe_events(
        &self,
        listener: Arc<dyn Fn(AppEventEnvelope) + Send + Sync>,
    ) -> Result<Box<dyn EventSubscription>, GatewayApplicationError>;
}

/// Dropping the subscription must synchronously unregister its callback.
pub(crate) trait EventSubscription: Send {}

pub(crate) struct GatewayConfig {
    pub local_auth: LocalAuthConfig,
    pub dev_cors_origin: Option<String>,
    pub message_rate_limit_max: u64,
    pub message_rate_limit_window: std::time::Duration,
    pub static_ui_root: Option<std::path::PathBuf>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            local_auth: LocalAuthConfig::default(),
            dev_cors_origin: None,
            message_rate_limit_max: 60,
            message_rate_limit_window: std::time::Duration::from_secs(60),
            static_ui_root: None,
        }
    }
}

pub(crate) struct GatewayServer {
    local_addr: SocketAddr,
    shutdown: CancellationToken,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

impl GatewayServer {
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Stop admission, terminate live streams, and wait for the listener task.
    pub(crate) async fn close(mut self) -> std::io::Result<()> {
        self.shutdown.cancel();
        self.task
            .take()
            .expect("gateway serving task is owned until close")
            .await
            .map_err(std::io::Error::other)?
    }
}

impl Drop for GatewayServer {
    fn drop(&mut self) {
        // Normal shutdown awaits `close`; partial initialization still stops
        // admission and streams instead of leaving a detached serving task.
        self.shutdown.cancel();
    }
}

pub(crate) async fn serve_gateway(
    listener: TcpListener,
    application: Arc<dyn GatewayApplication>,
    config: GatewayConfig,
) -> std::io::Result<GatewayServer> {
    let local_addr = listener.local_addr()?;
    let shutdown = CancellationToken::new();
    let router = http::router(application, config, shutdown.clone());
    let graceful = shutdown.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(graceful.cancelled_owned())
            .await
    });
    Ok(GatewayServer {
        local_addr,
        shutdown,
        task: Some(task),
    })
}

#[cfg(test)]
mod tests;
