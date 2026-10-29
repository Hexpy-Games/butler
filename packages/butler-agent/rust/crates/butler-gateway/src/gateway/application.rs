//! Durable application service behind the native App HTTP facade.

mod assets;
mod image_usage;
mod initiated;
pub use image_usage::{AppImageUsageCommand, ImageUsageOperation, ImageUsageRecord};
mod canon;
mod canon_proposals;
pub(crate) mod canon_sidebar;
mod data_reset;
pub use assets::{AppAssetCommand, GeneratedAssetKind, composite, mask_bounds};
mod admission;
mod admission_identity;
#[cfg(feature = "test-support")]
pub(crate) use admission_identity::canonical_client_id;
mod answer_drafts;
mod authority_permissions;
mod authority_recovery;
mod automations;
mod briefing_snapshot;
mod connectors;
mod context_details;
mod contracts;
mod errors;
mod event_outbox;
mod events;
mod thinking;
use crate::gateway::shutdown_trace::measure as measure_shutdown;

use errors::{app_error, public};
mod browser_stills;
mod devices;
mod documents;
mod event_reads;
#[cfg(feature = "e2e-fixtures")]
mod faults;
mod gateway_dashboard_impl;
mod gateway_impl;
mod gateway_mutations;
mod gateway_session_controls_impl;
mod handle;
mod hooks;
mod internal_continuation;
mod keyed_locks;
mod library;
pub use documents::AppDocumentCommand;
mod still_delivery;
pub use library::{AppLibraryChange, AppLibraryCommand, AppLibraryQuery};
mod signins;
pub use signins::*;
mod image_dimensions;
mod mcp_servers;
mod memory_management;
mod message_files;
mod message_projection;
mod message_visibility;
mod model_catalog;
mod monitoring;
mod new_chat_briefing;
mod operation_output;
mod panic_isolation;
mod personalization;
pub use memory_management::{AppMemoryCommand, AppMemoryPort, MemoryEventSink};
mod outputs;
mod pending_asks;
mod plan_decisions;
mod progress_view;
pub mod project_folder;
mod project_sources;
mod projection;
mod projects;
mod question_followup;
mod queue;
mod queue_dispatcher;
mod queue_view;
mod quota_events;
mod read_model;
mod recovery;
mod relocation_port;
mod retention;
mod retry;
mod send;
mod service;
mod session_branches;
mod session_controls;
mod session_queue_mutations;
mod session_relocation;
mod session_titles;
mod session_views;
mod sessions;
pub(super) mod settings;
mod setup;
mod setup_events;
mod skill_settings;
mod smart_groups;
mod subsession_events;
mod task_graphs;
pub use task_graphs::{
    project_task_graphs, task_graph_label, task_graph_model_label, task_graph_response,
};
mod shell;
mod space;
pub(super) mod storage;
mod transcript_export;
mod turn_cancellation;
mod turn_dispatch;
mod updates;
mod user_work;
mod wallpapers;

use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

use super::{
    AppEventEnvelope, ApplicationFuture, EventSubscription, GatewayApplication,
    GatewayApplicationError, MessageContent, MessageSendResult, PublishedEvent,
    RuntimeReadinessView, SendMessageCommand, SessionQueueUpdateRequest, SessionQueueView,
    wallpaper_store::AppWallpaperFiles,
};
use admission_identity::stringify;
pub(crate) use automations::*;
pub use briefing_snapshot::{read_new_chat_briefing_projects, read_new_chat_briefing_settings};
pub use contracts::*;
use events::{EventSubscribers, latest_event_cursor};
use keyed_locks::KeyedLocks;
pub use model_catalog::{AppModelCatalogCommand, AppModelCatalogPort};
pub use monitoring::{
    AppBoundWorkStatusFact, AppMonitorPage, AppMonitoringPort, AppUsageMonitorQuery,
    AppUsageMonitorView, AppWorkOperationalNoticeFact, AppWorkStatusConversationFact,
    AppWorkerActivityQuery,
};
pub(crate) use monitoring::{
    work_status as app_work_status, worker_activity as app_worker_activity,
};
pub use operation_output::{OperationOutputChunk, OperationOutputView};
pub use personalization::{
    AppPersonalizationCommand, AppPersonalizationEvent, AppPersonalizationPort,
    AppPersonalizationResult,
};
#[cfg(test)]
pub(crate) use plan_decisions::TestAppPlanDecisionLedger;
pub use plan_decisions::{
    AppPlanDecisionAction, AppPlanDecisionLedgerError, AppPlanDecisionLedgerFuture,
    AppPlanDecisionLedgerPort, AppPlanDecisionPlan, AppPlanDecisionRequest, AppPlanDecisionResult,
    AppPlanDecisionStatus,
};
pub(crate) use projects::AppProjectSummary;
pub use projects::{
    AppCreateProjectRequest, AppCreateProjectResult, AppProjectActionResult,
    AppProjectDashboardActionProgress, AppProjectDashboardBriefingPort,
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
    AppProjectUpdate,
};
#[cfg(test)]
pub(crate) use projects::{TestProjectDashboardBriefing, TestProjectDashboardLedger};
use queue::QueueClaim;
pub use relocation_port::{
    AppRelocateSessionRequest, AppRelocationBinding, AppRelocationBindingResult,
    AppRelocationBindingSeed, AppRelocationBindingUpdate, AppRelocationCanonicalUpdate,
    AppRelocationHost, AppRelocationSnapshot, AppRelocationTransportBinding,
    AppRelocationWorkspaceMarker, AppRelocationWorkspacePlan, AppRelocationWorkspaceRequest,
};
pub use session_branches::AppBranchSourceLocation;
pub(crate) use session_branches::{AppSessionBranchDestination, AppSessionBranchRequest};
pub use session_branches::{AppSessionBranchResult, AppStartTopicConversationRequest};
pub use session_controls::{AppSessionControlUpdate, AppSessionControlsView};
use session_queue_mutations::SessionQueueMutationOwner;
pub use sessions::{
    AppChatKind, AppChatSummary, AppCreateSessionInput, AppCreateSessionRequest,
    AppCreateSessionResult, AppSessionActionResult, AppSessionBranchQuery, AppSessionReadResult,
    AppSessionSummary, AppSessionUpdate, AppSessionWorkProgress, AppSessionWorkspaceProvisioner,
    AppSessionWorkspaceSnapshot, AppWorkProgress, AppWorkStreamQuery, AppWorkStreamReader,
    AppWorkStreamTurnOutcome, AppWorkspaceMode,
};
#[cfg(test)]
pub(crate) use setup::test_setup_port;
pub use setup::{
    AppCredentialReplaceInput, AppOauthStartInput, AppProviderKeyInput, AppSetupPort,
    ChatGptNoticeInput, ChatGptNoticeKind, ChatGptSignOutView, LocalModelServersView,
    MemoryModelProgress, OauthFlowStatus, OauthFlowView, ProviderKeyVerificationView,
    ReplacedCredentialView, SETUP_READINESS_EVENT, SavedCredentialView, SetupReadinessStatus,
    SetupReadinessStep, SetupReadinessView, SetupStepError, SetupStepStatus,
};
pub use space::{AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin};
use storage::{AppStorage, AppStorageError, CachedSql};
type SkillImportResult = butler_runtime::skills::SkillImportResult;
type SkillSettingsView = butler_runtime::skills::SkillSettingsView;
type StagedSkillArchive = butler_runtime::skills::StagedSkillArchive;
pub use transcript_export::TranscriptExport;
pub(crate) use transcript_export::TranscriptExportOwner;

/// Reuse the App projection's source public-event policy before transcript append.
pub fn normalize_committed_turn_event(
    kind: &str,
    visibility: &str,
    payload: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Map<String, serde_json::Value>, GatewayApplicationError> {
    projection::normalize_committed_turn_event(kind, visibility, payload).map_err(app_error)
}

pub fn app_session_hint(chat_id: &str) -> String {
    crate::gateway::application::snapshot_input::session_hint(chat_id)
}

pub struct AppApplication {
    storage: AppStorage,
    dependencies: Arc<AppApplicationDependencies>,
    subscribers: EventSubscribers,
    projection: projection::ProjectionOwner,
    retention: Option<retention::RetentionOwner>,
    queue_dispatcher: Option<queue_dispatcher::QueueDispatcher>,
    queue_wake: queue_dispatcher::QueueWake,
    automation_scheduler: Option<automations::AutomationScheduler>,
    automation_wake: Arc<tokio::sync::Notify>,
    automation_queued: Arc<std::sync::atomic::AtomicBool>,
    automation_runs: automations::AutomationRunOwner,
    composing: initiated::Composing,
    initiated_decisions: initiated::Decisions,
    queue_mutations: SessionQueueMutationOwner,
    session_creation: sessions::SessionCreationOwner,
    project_creation: projects::ProjectCreationOwner,
    session_branches: session_branches::SessionBranchOwner,
    session_titles: session_titles::SessionTitleOwner,
    smart_groups: smart_groups::SmartGroupOwner,
    space_mutations: Arc<space::SpaceMutationOwner>,
    transcript_exports: TranscriptExportOwner,
    project_dashboard_briefing: projects::ProjectDashboardBriefingOwner,
    queue_owner: String,
    butler_data: PathBuf,
    wallpapers: AppWallpaperFiles,
    asset_cache: assets::AssetCache,
    settings_update_lock: Arc<tokio::sync::Mutex<()>>,
    // True only after the startup relay has installed every pending reference.
    canon_file_lifetimes: Arc<tokio::sync::Mutex<bool>>,
    canon_projection_locks: KeyedLocks,
    plan_decision_locks: KeyedLocks,
    setup_readiness: setup::ReadinessRelay,
    chatgpt_events: setup_events::AccountRelay,
    quota_events: Arc<quota_events::QuotaEventForwarder>,
}

async fn initial_project_root(storage: &AppStorage) -> Result<PathBuf, GatewayApplicationError> {
    match storage.read(projects::effective_root).await {
        Ok(root) => Ok(root),
        Err(error) => {
            let _ = storage.close().await;
            Err(app_error(error))
        }
    }
}

impl AppApplication {
    pub async fn open(
        config: AppApplicationConfig,
        dependencies: AppApplicationDependencies,
    ) -> Result<Self, GatewayApplicationError> {
        let storage = handle::open_storage(&config, &dependencies).await?;
        let queue_owner = queue_owner_id(dependencies.identity_clock.as_ref());
        let project_root = initial_project_root(&storage).await?;
        let dependencies = Arc::new(dependencies);
        let subscribers = EventSubscribers::default();
        let (queue_dispatcher, queue_wake) =
            queue_dispatcher::QueueDispatcher::start(dependencies.service_shutdown.child_token());
        let (automation_wake, automation_queued) = automations::signals();
        let automation_scheduler = automations::AutomationScheduler::start(automation_wake.clone());
        let automation_runs = automations::AutomationRunOwner::start();
        let (retention, retention_wake) = handle::start_retention(&storage, &subscribers).await?;
        let projection =
            match projection::ProjectionOwner::start(projection::ProjectionContext::new(
                storage.clone(),
                dependencies.clone(),
                subscribers.clone(),
                config.butler_data.clone(),
                queue_wake.clone(),
                retention_wake,
                automation_wake.clone(),
            )) {
                Ok(projection) => projection,
                Err(error) => {
                    let _ = queue_dispatcher.close().await;
                    let _ = automation_scheduler.close().await;
                    let _ = automation_runs.close().await;
                    let _ = retention.close().await;
                    let _ = storage.close().await;
                    return Err(error);
                }
            };
        let application = Self {
            storage,
            dependencies,
            subscribers,
            projection,
            retention: Some(retention),
            queue_dispatcher: Some(queue_dispatcher.clone()),
            queue_wake,
            automation_scheduler: Some(automation_scheduler),
            composing: Default::default(),
            initiated_decisions: Default::default(),
            automation_wake,
            automation_queued,
            automation_runs,
            queue_mutations: SessionQueueMutationOwner::new(),
            session_creation: sessions::SessionCreationOwner::new(),
            project_creation: projects::ProjectCreationOwner::new(
                project_root.clone(),
                config.folder_selection_secret,
            ),
            session_branches: session_branches::SessionBranchOwner::new(),
            session_titles: session_titles::SessionTitleOwner::default(),
            smart_groups: smart_groups::SmartGroupOwner::default(),
            space_mutations: Arc::new(space::SpaceMutationOwner::new()),
            transcript_exports: TranscriptExportOwner::new(),
            project_dashboard_briefing: projects::ProjectDashboardBriefingOwner::new(),
            queue_owner,
            wallpapers: AppWallpaperFiles::new(&config.butler_data),
            asset_cache: assets::AssetCache::default(),
            butler_data: config.butler_data,
            settings_update_lock: Arc::new(tokio::sync::Mutex::new(())),
            canon_file_lifetimes: Arc::new(tokio::sync::Mutex::new(false)),
            canon_projection_locks: KeyedLocks::default(),
            plan_decision_locks: KeyedLocks::default(),
            setup_readiness: setup::ReadinessRelay::default(),
            chatgpt_events: setup_events::AccountRelay::default(),
            quota_events: Arc::default(),
        };
        application.initialize_thinking_preference().await?;
        application.recover_for_open().await?;
        Ok(application)
    }

    async fn recover_for_open(&self) -> Result<(), GatewayApplicationError> {
        self.recover_output_transfers().await?;
        self.surface_work_failures(None).await?;
        self.connect_update_progress().await;
        if let Err(error) = self.recover_session_relocation_owned().await {
            let _ = self.close().await;
            return Err(error);
        }
        Ok(())
    }

    /// The host initializes native admission before activating recovery, then
    /// starts HTTP admission only after this completes. Persisted queued
    /// messages can reach the native queue without racing external requests.
    pub async fn start_dispatch(&self) -> Result<(), GatewayApplicationError> {
        self.queue_dispatcher
            .as_ref()
            .ok_or(GatewayApplicationError::internal())?
            .initialize(self.clone_handle())
            .await?;
        // Settled Stops free their sessions before schedules catch up.
        self.recover_turn_cancellations().await?;
        let automation_scheduler = self
            .automation_scheduler
            .as_ref()
            .ok_or(GatewayApplicationError::internal())?;
        self.automation_runs.initialize(self.clone_handle()).await?;
        automation_scheduler.initialize(self.clone_handle())?;
        self.watch_wallpaper_modules().await;
        authority_recovery::retry(self).await;
        setup_events::start(self);
        self.quota_events.start(self.clone_handle());
        subsession_events::start(self);
        Ok(())
    }

    pub async fn drain_projection(&self) -> Result<(), GatewayApplicationError> {
        self.projection.drain().await
    }

    /// Finish any claimed queue admission while native enqueue is still ready.
    pub async fn stop_queue_dispatch(&self) -> Result<(), GatewayApplicationError> {
        match &self.queue_dispatcher {
            Some(dispatcher) => dispatcher.close().await,
            None => Ok(()),
        }
    }

    pub async fn stop_dispatch(&self) -> Result<(), GatewayApplicationError> {
        self.setup_readiness.close().await;
        self.chatgpt_events.close().await;
        let automations = match &self.automation_scheduler {
            Some(scheduler) => scheduler.close().await,
            None => Ok(()),
        };
        let automation_runs = self.automation_runs.close().await;
        self.quota_events.close().await;
        let queue = self.stop_queue_dispatch().await;
        automations.and(automation_runs).and(queue)
    }

    pub async fn close(&self) -> Result<(), GatewayApplicationError> {
        if let Some(port) = &self.dependencies.plugins {
            port.execute("connector_stop".into(), None, serde_json::json!({}))
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        self.cancel_updates();
        self.session_titles.close().await;
        self.smart_groups.close().await;
        measure_shutdown(
            "app_project_dashboard_briefing_join",
            self.project_dashboard_briefing.close(),
        )
        .await;
        let dispatch = measure_shutdown("app_dispatcher", self.stop_dispatch()).await;
        measure_shutdown(
            "app_transcript_exports_join",
            self.transcript_exports.close(),
        )
        .await;
        measure_shutdown("app_queue_mutations_join", self.queue_mutations.close()).await;
        measure_shutdown("app_session_creation_join", self.session_creation.close()).await;
        measure_shutdown("app_project_creation_join", self.project_creation.close()).await;
        measure_shutdown("app_session_branches_join", self.session_branches.close()).await;
        measure_shutdown("app_space_mutations_join", self.space_mutations.close()).await;
        measure_shutdown("app_wallpapers_join", self.wallpapers.close()).await;
        let projection = measure_shutdown("app_projection_join", self.projection.close()).await;
        let retention = match &self.retention {
            Some(retention) => measure_shutdown("app_retention_join", retention.close()).await,
            None => Ok(()),
        };
        let storage = measure_shutdown("app_storage_join", self.storage.close())
            .await
            .map_err(app_error);
        dispatch.and(projection).and(retention).and(storage)
    }

    pub fn cancel_updates(&self) {
        self.dependencies.updates.close();
    }

    async fn queue_page(
        &self,
        session_id: String,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        self.storage
            .read(move |db| queue_view::list(db, &session_id))
            .await
            .map_err(app_error)
    }
    async fn turn_page(
        &self,
        chat_id: String,
        cursor: f64,
    ) -> Result<super::TurnListView, GatewayApplicationError> {
        self.storage
            .read(move |db| read_model::list_turns(db, &chat_id, cursor))
            .await
            .map_err(app_error)
    }
}

/// A process-unique owner id for the session queue claim.
fn queue_owner_id(clock: &dyn AppIdentityClock) -> String {
    format!(
        "app-session-queue:{}:{}:{}",
        std::process::id(),
        clock.new_uuid(),
        clock.new_uuid()
    )
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn skill_error(error: butler_runtime::skills::SkillError) -> GatewayApplicationError {
    match error {
        butler_runtime::skills::SkillError::ArchiveInvalid(_)
        | butler_runtime::skills::SkillError::ArchivePathInvalid => {
            public(400, error.code(), &error.message())
        }
        butler_runtime::skills::SkillError::Closed => public(503, error.code(), &error.message()),
        _ => GatewayApplicationError::internal(),
    }
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
pub(crate) use test_support::seed_test_assistant_attachment;

mod snapshot_input;
#[cfg(test)]
mod tests;
