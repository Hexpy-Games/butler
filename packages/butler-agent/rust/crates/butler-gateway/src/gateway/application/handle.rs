use super::AppApplication;

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
            canon_projection_lock: self.canon_projection_lock.clone(),
            plan_decision_locks: self.plan_decision_locks.clone(),
            // Only the dispatching application relays readiness events.
            setup_readiness: super::setup::ReadinessRelay::default(),
            chatgpt_events: super::setup_events::AccountRelay::default(),
            quota_events: self.quota_events.clone(),
        }
    }
}
