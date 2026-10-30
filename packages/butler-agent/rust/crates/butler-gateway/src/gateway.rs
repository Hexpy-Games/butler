//! The App HTTP and WebSocket boundary.
//!
//! This module owns protocol validation, authentication, cursor projection, and
//! connection lifetimes. Durable message, Turn, and event state remains owned by
//! the required [`GatewayApplication`] implementation supplied at composition.

mod application;
/// The admission identity stored for a client message ID, for fixtures that seed admissions.
#[cfg(feature = "test-support")]
pub fn admission_client_id(value: &str) -> String {
    application::canonical_client_id(value)
}
pub use application::storage::history::{AppHistoryCommand, AppHistoryQuery};
#[cfg(feature = "test-support")]
pub use application::storage::testing as storage_testing;
mod file_watch;
pub use file_watch::FileChangeWatch;
mod auth;
mod crypto;
mod devices;
mod http;
mod idle_probe;
mod image_files;
mod live;
mod message_validation;
mod mutations;
mod pending_asks_port;
mod protocol;
pub use pending_asks_port::GatewayPendingAsks;
mod published_event;
mod rate_limit;
mod security_settings;
pub use devices::{GatewayDevices, PairedDevice};
mod server;
mod session_references;
mod shutdown_trace;
mod transcript;
mod ui_language;

pub(crate) use mutations::GatewayMutationCommands;
use std::sync::Arc;

use butler_runtime::operations::ProviderQuotaView;
use tokio_util::sync::CancellationToken;

pub use crate::gateway::inbound_queue::{
    ClaimedInboundEvent, InboundQueue, InboundQueueCode, InboundQueueError,
    InboundSettlementListener, QueuedInboundEvent,
};
pub use crate::gateway::message_file_store::AppMessageFiles;
pub use application::settings::{
    browsing_agent_setting, command_sandbox_enabled, diagnostics_enabled_readonly,
    producer_log_config, startup_log_config, stored_ui_language_readonly,
};
pub use application::{
    APP_PERSON_ID, AppAssetCommand, AppCanonOperation, AppCardInput, AppImageUsageCommand,
    AppProfileInput, AppSessionTopicClassifier, AppSessionTopicInput, AppSignInCommand,
    AppSignInUpsert, AppVaultCommand, GatewaySignIns, GeneratedAssetKind, ImageUsageOperation,
    ImageUsageRecord, composite, mask_bounds,
};
pub use application::{
    AppAdmissionAuthority, AppApplication, AppApplicationConfig, AppApplicationDependencies,
    AppApprovalClaims, AppArtifactMaterializer, AppAuthorityDecision, AppAuthorityDecisionInput,
    AppAuthorityHandoff, AppAuthorityPage, AppBoundWorkStatusFact, AppBranchCanonicalAnswer,
    AppBranchConversationReader, AppBranchSourceLocation, AppBranchSummarizer, AppBranchSummary,
    AppBranchSummaryInput, AppBriefingProject, AppCancellation, AppCanonConflict, AppCanonDelegate,
    AppCanonEvent, AppCanonPort, AppCanonRequest, AppCanonResource, AppCanonTagExists, AppChatKind,
    AppChatSummary, AppContextBudgetFacts, AppContextConfigurationFacts, AppContextReadFacts,
    AppContextReadPort, AppContextReadQuery, AppContextUsage, AppCreateProjectRequest,
    AppCreateProjectResult, AppCreateSessionInput, AppCreateSessionRequest, AppCreateSessionResult,
    AppDocumentCommand, AppExecutorReadiness, AppFileDownload, AppFileUpload, AppFileWrite,
    AppGrantRef, AppGrantView, AppIdentityClock, AppLedgerSourceRequest, AppLibraryChange,
    AppLibraryCommand, AppLibraryQuery, AppListCursor, AppListPage, AppMemoryCommand,
    AppMemoryPort, AppMessageFileSnapshot, AppMessageFileStorage, AppModelCatalogCommand,
    AppModelCatalogPort, AppModelFallbackFacts, AppModelMetadata, AppMonitorPage,
    AppMonitoringPort, AppNativeAssetResolver, AppNativeIngress, AppNewChatBriefingPort,
    AppNewChatBriefingRequest, AppPersonalizationCommand, AppPersonalizationEvent,
    AppPersonalizationPort, AppPersonalizationResult, AppPlanDecisionAction,
    AppPlanDecisionLedgerError, AppPlanDecisionLedgerFuture, AppPlanDecisionLedgerPort,
    AppPlanDecisionPlan, AppPlanDecisionRequest, AppPlanDecisionResult, AppPlanDecisionStatus,
    AppProjectActionResult, AppProjectDashboardActionProgress, AppProjectDashboardBriefingPort,
    AppProjectDashboardBriefingPrompt, AppProjectDashboardBriefingRequest,
    AppProjectDashboardCheckpoint, AppProjectDashboardDisposition, AppProjectDashboardLedgerError,
    AppProjectDashboardLedgerEvent, AppProjectDashboardLedgerFuture,
    AppProjectDashboardLedgerHistory, AppProjectDashboardLedgerPort,
    AppProjectDashboardLedgerRecord, AppProjectDashboardManagedPlan,
    AppProjectDashboardManagedWork, AppProjectDashboardPageQuery, AppProjectDashboardPinRef,
    AppProjectDashboardPreferencesUpdate, AppProjectDashboardRecordsQuery,
    AppProjectDashboardReview, AppProjectDashboardSnapshot, AppProjectDashboardSource,
    AppProjectDashboardSourceQuery, AppProjectDashboardStatisticsQuery, AppProjectDashboardWork,
    AppProjectDashboardWorkHistoryEntry, AppProjectGit, AppProjectList, AppProjectSource,
    AppProjectUpdate, AppQueueOwnerLiveness, AppReferencedChatSnapshot, AppRelocateSessionRequest,
    AppRelocationBinding, AppRelocationBindingResult, AppRelocationBindingSeed,
    AppRelocationBindingUpdate, AppRelocationCanonicalUpdate, AppRelocationHost,
    AppRelocationSnapshot, AppRelocationTransportBinding, AppRelocationWorkspaceMarker,
    AppRelocationWorkspacePlan, AppRelocationWorkspaceRequest, AppRoutinePreset,
    AppRuntimeInfoProvider, AppSessionActionResult, AppSessionBranchQuery, AppSessionBranchResult,
    AppSessionControlUpdate, AppSessionControlsView, AppSessionReadResult, AppSessionSummary,
    AppSessionTitleGenerator, AppSessionTitleInput, AppSessionUpdate, AppSessionViewPage,
    AppSessionWorkProgress, AppSessionWorkspaceProvisioner, AppSessionWorkspaceSnapshot,
    AppSettingsFacts, AppSettingsFactsProvider, AppSettingsMutationPort, AppSourceDocument,
    AppSourceSnapshotRequest, AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin,
    AppStartTopicConversationRequest, AppSubsessionPort, AppTaskGraphQuery, AppTurn,
    AppUsageMonitorQuery, AppUsageMonitorView, AppWorkOperationalNoticeFact, AppWorkProgress,
    AppWorkStatusConversationFact, AppWorkStreamQuery, AppWorkStreamReader,
    AppWorkStreamTurnOutcome, AppWorkerActivityQuery, AppWorkerActivitySourcePage,
    AppWorkspaceMode, ArtifactFileCandidate, ArtifactMaterializationRequest,
    ArtifactMaterializationResult, ClaimedNativeSnapshot, EnqueueReceipt,
    MaterializedResponderFile, MemoryEventSink, OperationOutputChunk, OperationOutputView,
    ProjectSnapshot, ResolvedNativeAssets, TranscriptExport, UnavailableCanon,
    VisualAdmissionRequest, project_task_graphs, task_graph_label, task_graph_model_label,
    task_graph_response,
};
pub use application::{
    AppCredentialReplaceInput, AppOauthStartInput, AppProviderKeyInput, AppSetupPort,
    ChatGptNoticeInput, ChatGptNoticeKind, ChatGptSignOutView, LocalModelServersView,
    MemoryModelProgress, OauthFlowStatus, OauthFlowView, ProviderKeyVerificationView,
    ReplacedCredentialView, SETUP_READINESS_EVENT, SavedCredentialView, SetupReadinessStatus,
    SetupReadinessStep, SetupReadinessView, SetupStepError, SetupStepStatus,
};
pub(crate) use application::{
    AutomationDetailView, AutomationListView, AutomationMutationResult, AutomationRunListView,
    AutomationRunResult, AutomationRunSummary, CreateAutomationRequest, UpdateAutomationRequest,
};
pub use application::{SMART_GROUP_INSTRUCTIONS, app_session_hint, normalize_committed_turn_event};
#[cfg(test)]
pub(crate) use application::{
    TestNewChatBriefing, TestProjectDashboardBriefing, TestProjectDashboardLedger,
};
pub(crate) use application::{app_work_status, app_worker_activity};
pub use application::{read_new_chat_briefing_projects, read_new_chat_briefing_settings};
pub use auth::LocalAuthConfig;
pub use image_files::AppImageFiles;
pub use protocol::{
    AppEventEnvelope, ArtifactKind, ArtifactOpenAction, ChangedFileDetail, DeliveryState,
    EventReplayView, HealthView, MessageContent, MessageContentPart, MessageFileKind,
    MessageFileRef, MessageListView, MessageRecord, MessageRole, MessageSendRequest,
    MessageSendResult, MessageStatus, ProgressState, ProjectSourceReference, QueueState,
    QueuedMessageRecord, RuntimeReadinessView, SendMessageCommand, SessionArtifactSummary,
    SessionControlState, SessionQueueUpdateRequest, SessionQueueView, TurnListView,
    TurnProgressSnapshotView, TurnRecord, TurnState,
};
pub use published_event::{EventSubscription, PublishedEvent};
pub use security_settings::{
    ADMIN_CREDENTIAL_HEADER, AllowedHostError, GatewayExposure, GatewaySecurityStore,
    MAX_ALLOWED_HOSTS, RotatedConnectionCode, normalize_allowed_host,
};
pub use server::{GatewayConfig, GatewayServer, HeadlessBrowserConfig, serve_gateway};
mod error;
pub use error::{ApplicationFuture, GatewayApplicationError};
pub use session_references::resolve_session_references;
pub use transcript::{TranscriptAppendListener, TranscriptCode, TranscriptWriter};
mod command_timing;
pub use wallpapers::{
    AppWallpaperAsset, AppWallpaperChange, AppWallpaperFile, AppWallpaperModuleShader,
    AppWallpaperModuleStatusReport, AppWallpaperRejection, AppWallpaperScope,
    AppWallpaperSetRequest, AppWallpaperVariant, GatewayWallpapers,
};

mod project_dashboard_contract;
pub use project_dashboard_contract::GatewayProjectDashboard;

/// Session controls and Plan decisions use the App revision and Project Ledger owners.
mod session_controls_contract;
pub use session_controls_contract::GatewaySessionControls;

/// The durable application operations consumed by the HTTP adapter.
///
/// Every method is required. Composition cannot replace absent persistence or
/// BTCC readiness with process-liveness guesses or an optional callback.
mod data_reset;
pub use data_reset::{AppDataResetPort, FullResetRequest, ResetNonce};

mod browser_still_delivery;
pub use browser_still_delivery::AppBrowserStillCommand;

mod application_port;
pub use application_port::GatewayApplication;

mod inbound_queue;
mod message_file_store;
#[cfg(test)]
mod tests;
mod wallpaper_modules;
mod wallpaper_store;
mod wallpapers;

pub use application::project_folder;

#[cfg(feature = "test-support")]
pub fn http_route_templates() -> Vec<&'static str> {
    http::route_templates()
}

pub use http::reset_browser_secret_keys;

pub use protocol::ImageEditRequest;
