use super::*;
use butler_core::hooks::{
    HookEvent, HookPort, PROJECT_HOOKS_CAPABILITY, ProjectHookRequest, ProjectHookReview,
};
use butler_turn::btcc::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityLoopContinuation, ProjectHooksCard, RequestDecision, SemanticTurn,
};
use serde::Deserialize;

impl GuidedTurnFactoryAdapter {
    pub(super) async fn hook_binding(
        &self,
        start: &GuidedTurnStart<'_>,
        phase: &butler_turn::btcc::GuidedPhaseSelection,
        semantic: &SemanticTurn,
        tools: &GuidedTools,
    ) -> Result<Option<butler_turn::btcc::GuidedHookBinding>, BtccError> {
        let Some(port) = self.hooks.clone() else {
            return Ok(None);
        };
        let turn = start.turn;
        let policy = &phase.execution_policy;
        let project_dir = policy
            .project_id
            .as_ref()
            .map(|_| policy.workspace_path.clone());
        let (port, project_hooks_card) = match &project_dir {
            Some(project_dir) => {
                self.project_hooks(
                    port,
                    project_dir,
                    start,
                    semantic,
                    tools,
                    &policy.access_mode,
                )
                .await?
            }
            None => (port, None),
        };
        let parent =
            if port.enabled(HookEvent::Stop, None) || port.enabled(HookEvent::SubagentStop, None) {
                self.subsessions
                    .hook_parent_session_id(turn.session_id.clone())
                    .await?
            } else {
                None
            };
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
            project_hooks_card,
        }))
    }

    /// Applies an answered card, reads the project's hook file once and decides what
    /// this execution does: run that content, run none of it, or wait for a card.
    async fn project_hooks(
        &self,
        port: Arc<dyn HookPort>,
        project_dir: &str,
        start: &GuidedTurnStart<'_>,
        semantic: &SemanticTurn,
        tools: &GuidedTools,
        access_mode: &butler_turn::btcc::AccessMode,
    ) -> Result<(Arc<dyn HookPort>, Option<ProjectHooksCard>), BtccError> {
        let turn = start.turn;
        let continuation = semantic.authority.as_ref();
        if let Some(answered) = continuation.filter(|c| c.project_hooks_card) {
            self.apply_answer(port.as_ref(), answered, turn, tools.authority_owner())
                .await?;
        }
        let cancel = start.cancellation.child_token();
        let mode = access_mode.as_str().to_owned();
        let review = port
            .review_project(project_dir.to_owned(), None)
            .await
            .unwrap_or(ProjectHookReview::None);
        Ok(match review {
            ProjectHookReview::None | ProjectHookReview::Denied => {
                let session = turn.session_id.clone();
                let _ = port.release_session_start(session, mode, cancel).await;
                (port, None)
            }
            ProjectHookReview::Trusted(project) => {
                let session = turn.session_id.clone();
                let _ = project.release_session_start(session, mode, cancel).await;
                (project, None)
            }
            // A turn resuming a tool's approval keeps that request; the next turn asks.
            ProjectHookReview::Undecided(_)
                if continuation.is_some_and(|c| !c.project_hooks_card) =>
            {
                (port, None)
            }
            ProjectHookReview::Undecided(mut request) => {
                let changed = request.changed;
                request.unsandboxed = *access_mode == butler_turn::btcc::AccessMode::FullAccess;
                let facts = card_facts(&request, project_dir, semantic, turn, tools)?;
                let card = if !self.unattended(turn).await? {
                    self.admit_card(facts).await?
                } else if changed {
                    // Hooks the user relied on did not run, and nobody could be asked.
                    tools.report_unattended(facts).await;
                    None
                } else {
                    None
                };
                (port, card)
            }
        })
    }

    async fn apply_answer(
        &self,
        port: &dyn HookPort,
        answered: &AuthorityLoopContinuation,
        turn: &butler_turn::btcc::TurnRecord,
        owner: &str,
    ) -> Result<(), BtccError> {
        let stored = self
            .preparation
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: owner.to_owned(),
                request_ref: answered.request_ref.clone(),
                source_session_id: Some(turn.session_id.clone()),
                client_message_id: None,
                turn_id: turn.turn_id.clone(),
            })
            .await
            .map_err(BtccError::from)?;
        let request = ProjectHookRequest::deserialize(&stored.normalized_input)
            .map_err(|_| error("authority_request_corrupt"))?;
        let allowed = stored.decision == RequestDecision::Allowed;
        if let Err(failure) = port.decide_project(request, allowed).await {
            // Nothing is remembered, so nothing runs: the next turn asks again.
            tracing::warn!(event = "project_hook_answer_not_saved", error = %failure);
        }
        Ok(())
    }

    /// Nobody can answer a scheduled run, or a child of one.
    async fn unattended(&self, turn: &butler_turn::btcc::TurnRecord) -> Result<bool, BtccError> {
        if turn.context.pointer("/scheduleRun/unattended") == Some(&serde_json::Value::Bool(true)) {
            return Ok(true);
        }
        Ok(self
            .subsessions
            .instruction_run_context(&turn.session_id)
            .await?
            .is_some_and(|run| run.unattended))
    }

    async fn admit_card(
        &self,
        facts: AuthorityAdmissionInput,
    ) -> Result<Option<ProjectHooksCard>, BtccError> {
        let call_id = facts.action_key.clone();
        let admitted = self
            .preparation
            .authority
            .admit(facts)
            .await
            .map_err(BtccError::from)?;
        // An answered request means saving its answer failed: nothing runs, no card again.
        Ok(match admitted {
            AuthorityAdmissionResult::Pending { request_ref, .. } => Some(ProjectHooksCard {
                request_ref,
                call_id,
            }),
            _ => None,
        })
    }
}

/// One card per turn and content: slots ignore the session, so another turn or chat
/// on the same folder must not share this one.
fn card_facts(
    request: &ProjectHookRequest,
    project_dir: &str,
    semantic: &SemanticTurn,
    turn: &butler_turn::btcc::TurnRecord,
    tools: &GuidedTools,
) -> Result<AuthorityAdmissionInput, BtccError> {
    let call_id = format!(
        "{PROJECT_HOOKS_CAPABILITY}:{}:{}",
        turn.turn_id, request.content_hash
    );
    let target = request.file.clone();
    let normalized_input =
        serde_json::to_value(request).map_err(|_| error("project_hooks_card_invalid"))?;
    Ok(AuthorityAdmissionInput {
        public_action_title: None,
        owner_session_id: tools.authority_owner().to_owned(),
        source_session_id: turn.session_id.clone(),
        source_turn_id: turn.turn_id.clone(),
        operation_occurrence_id: Some(call_id.clone()),
        source_work_id: String::new(),
        workspace_path: project_dir.to_owned(),
        plan_revision_id: String::new(),
        action_key: call_id,
        authority_generation: 1,
        capability: PROJECT_HOOKS_CAPABILITY.into(),
        target,
        model_ref: format!("{}/{}", semantic.model.provider, semantic.model.model),
        reasoning_effort: reasoning_text(&semantic.model.reasoning_effort)?,
        category: Some("reviewed_effect".into()),
        normalized_input,
        honor_standing_permission: false,
        unattended: false,
    })
}
