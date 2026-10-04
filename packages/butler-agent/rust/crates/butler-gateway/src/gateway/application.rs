//! Durable application service behind the native App HTTP facade.

mod admission;
mod admission_identity;
mod automations;
mod briefing_snapshot;
mod context_details;
mod contracts;
mod errors;
mod event_outbox;
mod events;
use crate::gateway::shutdown_trace::measure as measure_shutdown;

use errors::app_error;
mod devices;
#[cfg(debug_assertions)]
mod faults;
mod gateway_dashboard_impl;
mod gateway_impl;
mod gateway_mutations;
mod gateway_session_controls_impl;
mod handle;
mod internal_continuation;
mod mcp_servers;
mod message_files;
mod message_projection;
mod message_visibility;
mod model_catalog;
mod monitoring;
mod new_chat_briefing;
mod operation_output;
mod panic_isolation;
mod personalization;
mod plan_decisions;
mod progress_view;
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
mod session_views;
mod sessions;
mod settings;
mod setup;
mod turn_dispatch;
pub use settings::{diagnostics_enabled_readonly, stored_ui_language_readonly};
mod shell;
mod space;
mod storage;
mod transcript_export;
mod turn_cancellation;
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
use events::EventSubscribers;
pub use model_catalog::{AppModelCatalogCommand, AppModelCatalogPort};
pub use monitoring::{
    AppBoundWorkStatusFact, AppDeveloperLogsQuery, AppMonitorPage, AppMonitoringPort,
    AppUsageMonitorQuery, AppWorkOperationalNoticeFact, AppWorkStatusConversationFact,
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
pub(crate) use plan_decisions::PlanDecisionLocks;
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
pub(crate) use session_branches::{AppSessionBranchDestination, AppSessionBranchRequest};
pub use session_branches::{AppSessionBranchResult, AppStartTopicConversationRequest};
pub use session_controls::{AppSessionControlUpdate, AppSessionControlsView};
use session_queue_mutations::SessionQueueMutationOwner;
pub use sessions::{
    AppChatKind, AppChatSummary, AppCreateSessionInput, AppCreateSessionRequest,
    AppCreateSessionResult, AppSessionActionResult, AppSessionBranchQuery, AppSessionSummary,
    AppSessionUpdate, AppSessionWorkProgress, AppSessionWorkspaceProvisioner,
    AppSessionWorkspaceSnapshot, AppWorkProgress, AppWorkStreamQuery, AppWorkStreamReader,
    AppWorkStreamTurnOutcome, AppWorkspaceMode,
};
#[cfg(test)]
pub(crate) use setup::test_setup_port;
pub use setup::{
    AppCredentialReplaceInput, AppOauthStartInput, AppProviderKeyInput, AppSetupPort,
    LocalModelServersView, MemoryModelProgress, OauthFlowStatus, OauthFlowView,
    ProviderKeyVerificationView, ReplacedCredentialView, SETUP_READINESS_EVENT,
    SavedCredentialView, SetupReadinessStatus, SetupReadinessStep, SetupReadinessView,
    SetupStepError, SetupStepStatus,
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
    queue_mutations: SessionQueueMutationOwner,
    session_creation: sessions::SessionCreationOwner,
    project_creation: projects::ProjectCreationOwner,
    session_branches: session_branches::SessionBranchOwner,
    space_mutations: Arc<space::SpaceMutationOwner>,
    transcript_exports: TranscriptExportOwner,
    project_dashboard_briefing: projects::ProjectDashboardBriefingOwner,
    queue_owner: String,
    butler_data: PathBuf,
    wallpapers: AppWallpaperFiles,
    settings_update_lock: Arc<tokio::sync::Mutex<()>>,
    plan_decision_locks: PlanDecisionLocks,
    setup_readiness: setup::ReadinessRelay,
    quota_events: Arc<quota_events::QuotaEventForwarder>,
}

async fn initial_project_root(
    storage: &AppStorage,
    fallback: PathBuf,
) -> Result<PathBuf, GatewayApplicationError> {
    match storage
        .execute(move |db| projects::initial_root(db, &fallback))
        .await
    {
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
        let storage = AppStorage::open(
            config.database_path,
            Some(config.butler_data.clone()),
            dependencies.identity_clock.now_iso(),
        )
        .await
        .map_err(app_error)?;
        let queue_owner = queue_owner_id(dependencies.identity_clock.as_ref());
        let project_root =
            initial_project_root(&storage, config.project_workspace_root.clone()).await?;
        let dependencies = Arc::new(dependencies);
        let subscribers = EventSubscribers::default();
        let retention_cursor = latest_event_cursor(&storage).await?;
        let (queue_dispatcher, queue_wake) =
            queue_dispatcher::QueueDispatcher::start(dependencies.service_shutdown.child_token());
        let (automation_wake, automation_queued) = automations::signals();
        let automation_scheduler = automations::AutomationScheduler::start(automation_wake.clone());
        let automation_runs = automations::AutomationRunOwner::start();
        let (retention, retention_wake) = retention::RetentionOwner::start(
            storage.clone(),
            &subscribers.clone(),
            retention_cursor,
        );
        let projection =
            match projection::ProjectionOwner::start(projection::ProjectionContext::new(
                storage.clone(),
                dependencies.clone(),
                subscribers.clone(),
                config.butler_data.clone(),
                queue_wake.clone(),
                retention_wake,
                (automation_wake.clone(), automation_queued.clone()),
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
            space_mutations: Arc::new(space::SpaceMutationOwner::new()),
            transcript_exports: TranscriptExportOwner::new(),
            project_dashboard_briefing: projects::ProjectDashboardBriefingOwner::new(),
            queue_owner,
            wallpapers: AppWallpaperFiles::new(&config.butler_data),
            butler_data: config.butler_data,
            settings_update_lock: Arc::new(tokio::sync::Mutex::new(())),
            plan_decision_locks: PlanDecisionLocks::default(),
            setup_readiness: setup::ReadinessRelay::default(),
            quota_events: Arc::default(),
        };
        application.recover_for_open().await?;
        Ok(application)
    }

    async fn recover_for_open(&self) -> Result<(), GatewayApplicationError> {
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
        let automation_scheduler = self
            .automation_scheduler
            .as_ref()
            .ok_or(GatewayApplicationError::internal())?;
        self.automation_runs.initialize(self.clone_handle()).await?;
        automation_scheduler.initialize(self.clone_handle())?;
        self.recover_turn_cancellations().await?;
        self.watch_wallpaper_modules().await;
        // Failed authority retries remain durable for the next startup.
        if let Ok(followups) = self.dependencies.authority_handoff.retry_decided().await {
            for (owner, request_ref, input) in followups {
                let session = owner.strip_prefix("butler/app-").unwrap_or(&owner);
                let _ = question_followup::send(self, session, &request_ref, &input).await;
            }
        }
        self.setup_readiness.start(
            self.dependencies.setup.readiness(),
            self.storage.clone(),
            self.subscribers.clone(),
            self.dependencies.identity_clock.clone(),
        );
        self.quota_events.start(self.clone_handle());
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
        self.cancel_updates();
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

    async fn message_page(
        &self,
        chat_id: String,
        cursor: f64,
        limit: usize,
    ) -> Result<super::MessageListView, GatewayApplicationError> {
        self.storage
            .execute(move |db| read_model::list_messages(db, &chat_id, cursor, limit))
            .await
            .map_err(app_error)
    }
    async fn artifact_page(
        &self,
        session_id: String,
    ) -> Result<Vec<super::SessionArtifactSummary>, GatewayApplicationError> {
        self.storage
            .execute(move |db| read_model::list_artifacts(db, &session_id))
            .await
            .map_err(app_error)
    }
    async fn queue_page(
        &self,
        session_id: String,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        self.storage
            .execute(move |db| queue_view::list(db, &session_id))
            .await
            .map_err(app_error)
    }
    async fn turn_page(
        &self,
        chat_id: String,
        cursor: f64,
    ) -> Result<super::TurnListView, GatewayApplicationError> {
        self.storage
            .execute(move |db| read_model::list_turns(db, &chat_id, cursor))
            .await
            .map_err(app_error)
    }
}

/// The newest durable event cursor; storage is closed when it cannot be read.
async fn latest_event_cursor(storage: &AppStorage) -> Result<u64, GatewayApplicationError> {
    match storage
        .execute(|connection| events::latest(connection))
        .await
    {
        Ok(cursor) => Ok(cursor),
        Err(error) => {
            let _ = storage.close().await;
            Err(app_error(error))
        }
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

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
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
