//! Ledger mutations precede the atomic BTCC delegation and pending dispatch.
use super::*;
use crate::btcc::{DurableWorkStatus, ExecutionMode, PlanAction, ReplacePlanInput};

impl SubsessionService {
    pub(super) async fn project_handoff(
        &self,
        request: StewardDelegationRequest,
        scope: WorkTurnScope,
        call: String,
        checks: Option<Vec<String>>,
        epic: Option<String>,
    ) -> Result<Value, BtccError> {
        // A committed delegation wins even if its Work has since settled.
        if let Some(stored) = self
            .repository
            .handoff_for_call(scope.clone(), call.clone())
            .await
            .map_err(BtccError::from)?
        {
            self.dispatch_handoff(&stored).await?;
            return Ok(delegation_output(&stored));
        }
        let work = self
            .project_handoff_work(scope, &call, &request.request, checks, epic)
            .await?;
        #[cfg(feature = "e2e-fixtures")]
        super::handoff_hold::after_plan().await?;
        let create = self.project_handoff_intent(&request, &work, &call).await?;
        let now = create.created_at.clone();
        let stored = self
            .repository
            .create_project_handoff(create, work, now)
            .await
            .map_err(BtccError::from)?;
        self.dispatch_handoff(&stored).await?;
        Ok(delegation_output(&stored))
    }

    async fn project_handoff_intent(
        &self,
        request: &StewardDelegationRequest,
        work: &WorkView,
        call: &str,
    ) -> Result<SubsessionCreate, BtccError> {
        let parent = self
            .parent_binding(
                &request.parent_session_id,
                SessionRole::Butler,
                BtccCode::ParentButlerSessionRequired,
            )
            .await?;
        let chat = parent
            .transport_bindings
            .iter()
            .find(|binding| binding.transport == "app" && !binding.peer_id.trim().is_empty())
            .map(|binding| binding.peer_id.clone())
            .ok_or_else(|| error(BtccCode::ParentAppBindingRequired))?;
        let prior = self.followup_context(request).await?;
        let mut parent_work = work.clone();
        parent_work.latest_plan_review = None;
        one_call::build(
            request,
            &parent,
            chat,
            &parent_work,
            prior,
            call,
            &(self.now)(),
        )
        .map_err(BtccError::from)
    }

    async fn project_handoff_work(
        &self,
        scope: WorkTurnScope,
        call: &str,
        objective: &str,
        checks: Option<Vec<String>>,
        epic: Option<String>,
    ) -> Result<WorkView, BtccError> {
        let bound = self.work.bound_work_for_turn(scope.turn_id.clone()).await?;
        let continuing = if let Some(work) = &bound {
            matches!(
                work.status,
                DurableWorkStatus::Open | DurableWorkStatus::Blocked
            ) && !self
                .work
                .steward_owns_work(scope.session_id.clone(), work.work_id.clone())
                .await?
        } else {
            false
        };
        let prior_plan = bound
            .as_ref()
            .filter(|_| continuing)
            .and_then(|work| work.current_plan.as_ref());
        let checks = checks.unwrap_or_else(|| {
            prior_plan
                .map(|plan| plan.checks.clone())
                .unwrap_or_default()
        });
        let refs = epic.map(|epic| vec![epic]).unwrap_or_else(|| {
            prior_plan
                .map(|plan| plan.governing_refs.clone())
                .unwrap_or_default()
        });
        self.repository
            .precheck_handoff(
                scope.session_id.clone(),
                bound
                    .as_ref()
                    .filter(|_| continuing)
                    .map(|work| work.work_id.clone()),
                refs.clone(),
            )
            .await
            .map_err(BtccError::from)?;
        if !continuing {
            self.work
                .start_handoff_work(StartWorkInput {
                    scope: scope.clone(),
                    mutation_call_id: handoff_mutation("start", call),
                    objective: objective.into(),
                    backfill_tool_call_ids: None,
                })
                .await?;
        }
        self.work
            .replace_plan(runtime_plan(scope, call, objective, checks, refs))
            .await
    }

    async fn dispatch_handoff(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        if self
            .repository
            .result_for_relation(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_none()
        {
            self.prepare_child_binding(stored).await?;
            self.replay(stored).await?;
        }
        Ok(())
    }
}

fn handoff_mutation(operation: &str, call: &str) -> String {
    crate::btcc::digest_identity(&format!("one-call-{operation}\0{call}"))
}

fn runtime_plan(
    scope: WorkTurnScope,
    call: &str,
    objective: &str,
    checks: Vec<String>,
    refs: Vec<String>,
) -> ReplacePlanInput {
    ReplacePlanInput {
        scope,
        mutation_call_id: handoff_mutation("plan", call),
        start_new: None,
        backfill_tool_call_ids: None,
        objective: objective.into(),
        governing_refs: Some(refs),
        execution_mode: Some(ExecutionMode::Steward),
        actions: vec![PlanAction {
            action_key: "delegated-objective".into(),
            description: objective.into(),
            dependency_keys: vec![],
            effect: None,
        }],
        checks,
    }
}
