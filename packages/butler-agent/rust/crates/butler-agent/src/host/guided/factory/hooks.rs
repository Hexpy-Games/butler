use super::*;
impl GuidedTurnFactoryAdapter {
    pub(super) async fn hook_binding(
        &self,
        turn: &butler_turn::btcc::TurnRecord,
        phase: &butler_turn::btcc::GuidedPhaseSelection,
    ) -> Result<Option<butler_turn::btcc::GuidedHookBinding>, BtccError> {
        let Some(port) = self.hooks.clone() else {
            return Ok(None);
        };
        let policy = &phase.execution_policy;
        let parent = if port.enabled(butler_core::hooks::HookEvent::Stop, None)
            || port.enabled(butler_core::hooks::HookEvent::SubagentStop, None)
        {
            self.subsessions
                .hook_parent_session_id(turn.session_id.clone())
                .await?
        } else {
            None
        };
        let project_dir = policy
            .project_id
            .as_ref()
            .map(|_| policy.workspace_path.clone());
        let cwd = project_dir.clone().unwrap_or_else(|| {
            butler_platform::user_dirs::home_dir()
                .unwrap_or_else(|| self.butler_data.clone())
                .to_string_lossy()
                .into_owned()
        });
        let access_mode = policy.access_mode.as_str().into();
        Ok(Some(butler_turn::btcc::GuidedHookBinding {
            port,
            parent_session_id: parent,
            project_dir,
            cwd,
            access_mode,
        }))
    }
}
