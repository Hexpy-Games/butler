//! Durable application service behind the native App HTTP facade.

mod admission;
mod admission_identity;
mod automations;
mod briefing_snapshot;
mod context_details;
mod contracts;
mod events;
mod gateway_dashboard_impl;
mod gateway_impl;
mod gateway_mutations;
mod gateway_session_controls_impl;
mod handle;
mod internal_continuation;
mod message_files;
mod message_projection;
mod model_catalog;
mod monitoring;
mod native_preparation;
mod new_chat_briefing;
mod operation_output;
mod personalization;
mod plan_decisions;
mod progress_view;
mod project_sources;
mod projection;
mod projects;
mod queue;
mod queue_dispatcher;
mod queue_view;
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
pub(crate) use settings::diagnostics_enabled_readonly;
mod shell;
mod space;
mod storage;
mod transcript_export;
mod turn_cancellation;
mod updates;

use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

use super::{
    AppEventEnvelope, ApplicationFuture, EventSubscription, GatewayApplication,
    GatewayApplicationError, MessageContent, MessageSendResult, RuntimeReadinessView,
    SendMessageCommand, SessionQueueUpdateRequest, SessionQueueView,
};
use admission_identity::stringify;
pub(crate) use automations::*;
pub(crate) use briefing_snapshot::{
    read_new_chat_briefing_projects, read_new_chat_briefing_settings,
};
pub(crate) use contracts::*;
use events::EventSubscribers;
pub(crate) use model_catalog::{AppModelCatalogCommand, AppModelCatalogPort};
pub(crate) use monitoring::{
    AppBoundWorkStatusFact, AppDeveloperLogsQuery, AppMonitorPage, AppMonitoringPort,
    AppUsageMonitorQuery, AppWorkOperationalNoticeFact, AppWorkStatusConversationFact,
    AppWorkerActivityQuery,
};
pub(crate) use monitoring::{
    work_status as app_work_status, worker_activity as app_worker_activity,
};
pub(crate) use operation_output::{OperationOutputChunk, OperationOutputView};
pub(crate) use personalization::{
    AppPersonalizationCommand, AppPersonalizationEvent, AppPersonalizationPort,
    AppPersonalizationResult,
};
#[cfg(test)]
pub(crate) use plan_decisions::TestAppPlanDecisionLedger;
pub(crate) use plan_decisions::{
    AppPlanDecisionAction, AppPlanDecisionLedgerError, AppPlanDecisionLedgerFuture,
    AppPlanDecisionLedgerPort, AppPlanDecisionPlan, AppPlanDecisionRequest, AppPlanDecisionResult,
    AppPlanDecisionStatus, PlanDecisionLocks,
};
pub(crate) use projects::{
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
    AppProjectDashboardWorkHistoryEntry, AppProjectList, AppProjectSource, AppProjectSummary,
    AppProjectUpdate,
};
#[cfg(test)]
pub(crate) use projects::{TestProjectDashboardBriefing, TestProjectDashboardLedger};
use queue::QueueClaim;
pub(crate) use relocation_port::{
    AppRelocateSessionRequest, AppRelocationBinding, AppRelocationBindingResult,
    AppRelocationBindingSeed, AppRelocationBindingUpdate, AppRelocationCanonicalUpdate,
    AppRelocationHost, AppRelocationSnapshot, AppRelocationTransportBinding,
    AppRelocationWorkspaceMarker, AppRelocationWorkspacePlan, AppRelocationWorkspaceRequest,
};
pub(crate) use session_branches::{AppSessionBranchResult, AppStartTopicConversationRequest};
pub(crate) use session_controls::{AppSessionControlUpdate, AppSessionControlsView};
use session_queue_mutations::SessionQueueMutationOwner;
pub(crate) use sessions::{
    AppChatKind, AppChatSummary, AppCreateSessionInput, AppCreateSessionRequest,
    AppCreateSessionResult, AppSessionActionResult, AppSessionBranchQuery, AppSessionSummary,
    AppSessionUpdate, AppSessionWorkProgress, AppSessionWorkspaceProvisioner,
    AppSessionWorkspaceSnapshot, AppWorkProgress, AppWorkStreamQuery, AppWorkStreamReader,
    AppWorkStreamTurnOutcome, AppWorkspaceMode,
};
pub(crate) use space::{AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin};
use storage::{AppStorage, AppStorageError};
type SkillImportResult = crate::skills::SkillImportResult;
type SkillSettingsView = crate::skills::SkillSettingsView;
type StagedSkillArchive = crate::skills::StagedSkillArchive;
pub(crate) use transcript_export::{TranscriptExport, TranscriptExportOwner};

/// Reuse the App projection's source public-event policy before transcript append.
pub(crate) fn normalize_committed_turn_event(
    kind: &str,
    visibility: &str,
    payload: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Map<String, serde_json::Value>, GatewayApplicationError> {
    projection::normalize_committed_turn_event(kind, visibility, payload).map_err(app_error)
}

pub(crate) fn app_session_hint(chat_id: &str) -> String {
    native_preparation::session_hint(chat_id)
}

pub(crate) struct AppApplication {
    storage: AppStorage,
    dependencies: Arc<AppApplicationDependencies>,
    subscribers: EventSubscribers,
    projection: projection::ProjectionOwner,
    retention: Option<retention::RetentionOwner>,
    queue_dispatcher: Option<queue_dispatcher::QueueDispatcher>,
    queue_wake: queue_dispatcher::QueueWake,
    automation_scheduler: Option<automations::AutomationScheduler>,
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
    settings_update_lock: Arc<tokio::sync::Mutex<()>>,
    plan_decision_locks: PlanDecisionLocks,
}

impl AppApplication {
    pub(crate) async fn open(
        config: AppApplicationConfig,
        dependencies: AppApplicationDependencies,
    ) -> Result<Self, GatewayApplicationError> {
        let initialized_at = dependencies.identity_clock.now_iso();
        let storage = AppStorage::open(
            config.database_path,
            Some(config.butler_data.clone()),
            initialized_at,
        )
        .await
        .map_err(app_error)?;
        let queue_owner = format!(
            "app-session-queue:{}:{}:{}",
            std::process::id(),
            dependencies.identity_clock.new_uuid(),
            dependencies.identity_clock.new_uuid()
        );
        let fallback_project_root = config.project_workspace_root.clone();
        let project_root = match storage
            .execute(move |db| projects::initial_root(db, &fallback_project_root))
            .await
        {
            Ok(root) => root,
            Err(error) => {
                let _ = storage.close().await;
                return Err(app_error(error));
            }
        };
        let dependencies = Arc::new(dependencies);
        let subscribers = EventSubscribers::default();
        let retention_cursor = match storage
            .execute(|connection| events::latest(connection))
            .await
        {
            Ok(cursor) => cursor,
            Err(error) => {
                let _ = storage.close().await;
                return Err(app_error(error));
            }
        };
        let (queue_dispatcher, queue_wake) = queue_dispatcher::QueueDispatcher::start();
        let automation_scheduler = automations::AutomationScheduler::start();
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
            butler_data: config.butler_data,
            settings_update_lock: Arc::new(tokio::sync::Mutex::new(())),
            plan_decision_locks: PlanDecisionLocks::default(),
        };
        if let Err(error) = application.recover_session_relocation_owned().await {
            let _ = application.close().await;
            return Err(error);
        }
        Ok(application)
    }

    /// The HTTP owner activates recovery only after its listener is ready.
    /// Otherwise a persisted queued message can fail the readiness admission
    /// guard during startup before it ever reaches the native queue.
    pub(crate) async fn start_dispatch(&self) -> Result<(), GatewayApplicationError> {
        self.queue_dispatcher
            .as_ref()
            .ok_or(GatewayApplicationError::Internal)?
            .initialize(self.clone_handle())
            .await?;
        let automation_scheduler = self
            .automation_scheduler
            .as_ref()
            .ok_or(GatewayApplicationError::Internal)?;
        self.automation_runs.initialize(self.clone_handle()).await?;
        automation_scheduler.initialize(self.clone_handle()).await?;
        self.recover_turn_cancellations().await?;
        // Failed authority retries remain durable for the next startup.
        let _ = self.dependencies.authority_handoff.retry_decided().await;
        Ok(())
    }

    pub(crate) async fn stop_dispatch(&self) -> Result<(), GatewayApplicationError> {
        let automations = match &self.automation_scheduler {
            Some(scheduler) => scheduler.close().await,
            None => Ok(()),
        };
        let automation_runs = self.automation_runs.close().await;
        let queue = match &self.queue_dispatcher {
            Some(dispatcher) => dispatcher.close().await,
            None => Ok(()),
        };
        automations.and(automation_runs).and(queue)
    }

    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        self.cancel_updates();
        self.project_dashboard_briefing.close().await;
        let dispatch = self.stop_dispatch().await;
        self.transcript_exports.close().await;
        self.queue_mutations.close().await;
        self.session_creation.close().await;
        self.project_creation.close().await;
        self.session_branches.close().await;
        self.space_mutations.close().await;
        let projection = self.projection.close().await;
        let retention = match &self.retention {
            Some(retention) => retention.close().await,
            None => Ok(()),
        };
        let storage = self.storage.close().await.map_err(app_error);
        dispatch.and(projection).and(retention).and(storage)
    }

    pub(crate) fn cancel_updates(&self) {
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

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn skill_error(error: crate::skills::SkillError) -> GatewayApplicationError {
    match error.code {
        "skill_archive_invalid" | "skill_archive_path_invalid" => {
            public(400, error.code, &error.message)
        }
        "skills_closed" => public(503, error.code, &error.message),
        _ => GatewayApplicationError::Internal,
    }
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn app_error(error: AppStorageError) -> GatewayApplicationError {
    match error.code() {
        "session_not_found" => public(404, error.code(), error.detail()),
        "automation_not_found" => public(404, error.code(), error.detail()),
        "automation_not_enabled" | "automation_state_invalid" => {
            public(409, error.code(), error.detail())
        }
        "automation_interval_invalid" => public(400, error.code(), error.detail()),
        "project_required" => public(400, error.code(), error.detail()),
        "project_not_found" => public(404, error.code(), error.detail()),
        "general_channel_protected" => public(409, error.code(), error.detail()),
        "message_file_not_found"
        | "too_many_attachments"
        | "empty_queued_message"
        | "invalid_message_content" => public(400, error.code(), error.detail()),
        "message_file_wrong_session" => public(403, error.code(), error.detail()),
        "message_file_already_attached" | "queued_message_changed" => {
            public(409, error.code(), error.detail())
        }
        "queued_message_identity_conflict"
        | "project_source_scope_changed"
        | "session_relocating"
        | "session_model_unavailable"
        | "authority_queue_immutable"
        | "queued_message_cas_conflict" => public(409, error.code(), error.detail()),
        "queued_message_not_found" => public(404, error.code(), error.detail()),
        "turn_not_found" => public(404, error.code(), error.detail()),
        "turn_not_cancellable" => public(409, error.code(), error.detail()),
        "turn_control_resolution_invalid" => public(500, error.code(), error.detail()),
        _ => GatewayApplicationError::Internal,
    }
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
pub(crate) use test_support::{
    seed_test_assistant_attachment, seed_test_authority_queue, seed_test_transcript_messages,
};

#[cfg(test)]
mod tests;
