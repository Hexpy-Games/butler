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
            automation_runs: self.automation_runs.clone(),
            queue_mutations: self.queue_mutations.clone(),
            session_creation: self.session_creation.clone(),
            project_creation: self.project_creation.clone(),
            session_branches: self.session_branches.clone(),
            space_mutations: self.space_mutations.clone(),
            transcript_exports: self.transcript_exports.clone(),
            project_dashboard_briefing: self.project_dashboard_briefing.clone(),
            queue_owner: self.queue_owner.clone(),
            butler_data: self.butler_data.clone(),
            settings_update_lock: self.settings_update_lock.clone(),
            plan_decision_locks: self.plan_decision_locks.clone(),
        }
    }
}
