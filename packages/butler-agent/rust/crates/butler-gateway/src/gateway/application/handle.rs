use super::{
    AppApplication, AppApplicationConfig, AppApplicationDependencies, AppStorage,
    GatewayApplicationError, app_error,
};

impl AppApplication {
    pub(super) fn clone_handle(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            dependencies: self.dependencies.clone(),
            subscribers: self.subscribers.clone(),
            projection: self.projection.clone(),
            retention: None,
            queue_dispatcher: None,
            queue_wake: self.queue_wake.clone(),
            automation_scheduler: None,
            composing: self.composing.clone(),
            initiated_decisions: self.initiated_decisions.clone(),
            automation_wake: self.automation_wake.clone(),
            automation_queued: self.automation_queued.clone(),
            automation_runs: self.automation_runs.clone(),
            queue_mutations: self.queue_mutations.clone(),
            session_creation: self.session_creation.clone(),
            project_creation: self.project_creation.clone(),
            session_branches: self.session_branches.clone(),
            session_titles: self.session_titles.clone(),
            smart_groups: self.smart_groups.clone(),
            space_mutations: self.space_mutations.clone(),
            transcript_exports: self.transcript_exports.clone(),
            project_dashboard_briefing: self.project_dashboard_briefing.clone(),
            queue_owner: self.queue_owner.clone(),
            butler_data: self.butler_data.clone(),
            wallpapers: self.wallpapers.clone(),
            asset_cache: self.asset_cache.clone(),
            settings_update_lock: self.settings_update_lock.clone(),
            canon_file_lifetimes: self.canon_file_lifetimes.clone(),
            canon_projection_locks: self.canon_projection_locks.clone(),
            plan_decision_locks: self.plan_decision_locks.clone(),
            session_cleanup_locks: self.session_cleanup_locks.clone(),
            // Only the dispatching application relays readiness events.
            setup_readiness: super::setup::ReadinessRelay::default(),
            chatgpt_events: super::setup_events::AccountRelay::default(),
            quota_events: self.quota_events.clone(),
        }
    }
}

pub(super) async fn open_storage(
    config: &AppApplicationConfig,
    dependencies: &AppApplicationDependencies,
) -> Result<AppStorage, GatewayApplicationError> {
    AppStorage::open(
        config.database_path.clone(),
        Some(config.butler_data.clone()),
        dependencies.identity_clock.now_iso(),
    )
    .await
    .map_err(app_error)
}

pub(super) async fn start_retention(
    storage: &AppStorage,
    subscribers: &super::EventSubscribers,
) -> Result<
    (
        super::retention::RetentionOwner,
        super::retention::RetentionWake,
    ),
    GatewayApplicationError,
> {
    let cursor = super::latest_event_cursor(storage).await?;
    Ok(super::retention::RetentionOwner::start(
        storage.clone(),
        subscribers,
        cursor,
    ))
}
