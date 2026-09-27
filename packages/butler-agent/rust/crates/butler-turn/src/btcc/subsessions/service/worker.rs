//! Reviewed Steward Plan action to durable Worker dispatch.

use super::*;
use crate::btcc::{BtccCode, BtccError};

impl SubsessionService {
    /// Delegates one executable action of a reviewed Workers-mode plan to a
    /// worker subsession. The delegation is idempotent.
    pub async fn delegate_worker(
        &self,
        request: WorkerDelegationRequest,
        reviewed: &WorkView,
    ) -> Result<Value, BtccError> {
        let parent = self
            .parent_binding(
                &request.parent_session_id,
                SessionRole::Steward,
                BtccCode::ParentStewardSessionRequired,
            )
            .await?;
        let (plan, review) = accepted_plan(
            reviewed,
            ExecutionMode::Workers,
            BtccCode::WorkerDelegationPlanModeRequired,
        )?;
        let action = executable_action(reviewed, plan, &request.action_key)?;
        let profile = self.profiles.read(request.profile_id.clone()).await?;
        let identity = json!({"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"action_key":request.action_key,"objective":request.objective,"acceptance_criteria":request.acceptance_criteria,"implementation_brief":request.implementation_brief,"profile_id":profile.id});
        let delegation_id = delegation::delegation_id(&delegation::WORKER, &identity)?;
        if let Some(existing) = self.replay_existing(&delegation_id).await? {
            return Ok(
                json!({"ok":true,"status":"queued","relation_id":existing.relation_id,"child_session_id":existing.child_session_id,"task_id":existing.task_id}),
            );
        }
        let ids = delegation::DelegationIds::derive(&delegation::WORKER, delegation_id);
        let now = (self.now)();
        let packet = json!({"child_role":"worker","delegation_id":ids.delegation_id,"source_tool_call_id":request.source_tool_call_id,"task_id":ids.task_id,"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"relation_id":ids.relation_id,"access_mode":request.access_mode,"execution_mode":if request.access_mode=="read_only"{"read_only"}else{"mutation"},"objective":request.objective,"acceptance_criteria":request.acceptance_criteria,"implementation_brief":request.implementation_brief,"plan_action":{"action_key":action.action_key,"description":action.description,"dependency_keys":action.dependency_keys},"task_or_plan_refs":[plan.plan_revision_id],"constraints_and_non_goals":["Execute only this bounded Task and report to the Steward."],"allowed_tools_and_effects":allowed_effects(&request.access_mode),"mutation_scope":mutation_scope(&request.access_mode),"parent_work_ref":{"work_id":reviewed.work_id,"session_id":reviewed.session_id,"turn_id":request.parent_turn_id,"plan_revision_id":plan.plan_revision_id,"review_revision_id":review.review_revision_id},"worker_profile":{"id":profile.id,"job":profile.job},"model_ref":profile.model_ref,"reasoning_effort":profile.reasoning_effort});
        let envelope = child_envelope(ChildEnvelopeInput {
            role: "worker",
            delegation: &ids.delegation_id,
            child: &ids.child_session_id,
            parent_id: &request.parent_session_id,
            turn: &ids.child_turn_id,
            parent: &parent,
            model: &profile.model_ref,
            reasoning: &profile.reasoning_effort,
            text: render_input(&packet, profile.prompt.as_deref()),
            now: &now,
        });
        let intent = json!({"envelope":envelope,"metadata":{"source":"btcc-worker-delegation"}});
        let stored = self
            .create_and_dispatch(ids.create(
                delegation::Parent {
                    session_id: request.parent_session_id,
                    turn_id: request.parent_turn_id,
                    anchor_message_id: request.anchor_message_id,
                },
                request.safe_title.unwrap_or_else(|| "Worker task".into()),
                packet,
                intent,
                now,
            ))
            .await?;
        Ok(
            json!({"ok":true,"status":"queued","relation_id":stored.relation_id,"child_session_id":stored.child_session_id,"task_id":stored.task_id}),
        )
    }
}

/// The plan action to delegate: not finished or blocked, with every
/// dependency done or skipped.
fn executable_action<'a>(
    reviewed: &WorkView,
    plan: &'a crate::btcc::WorkPlan,
    action_key: &str,
) -> Result<&'a crate::btcc::PlanAction, BtccError> {
    let action = plan
        .actions
        .iter()
        .find(|a| a.action_key == action_key)
        .ok_or_else(|| error(BtccCode::WorkerPlanActionMissing))?;
    let status = |key: &str| {
        reviewed
            .action_progress
            .iter()
            .find(|p| p.action_key == key)
            .map(|p| p.status)
    };
    if matches!(
        status(action_key).unwrap_or(ActionStatus::Pending),
        ActionStatus::Done | ActionStatus::Skipped | ActionStatus::Blocked
    ) {
        return Err(error(BtccCode::WorkerPlanActionNotExecutable));
    }
    if action.dependency_keys.iter().any(|dependency| {
        !matches!(
            status(dependency),
            Some(ActionStatus::Done | ActionStatus::Skipped)
        )
    }) {
        return Err(error(BtccCode::WorkerPlanActionDependencyIncomplete));
    }
    Ok(action)
}
