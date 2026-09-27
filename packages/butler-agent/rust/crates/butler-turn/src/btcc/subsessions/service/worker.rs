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
        let identity = packets::worker_identity(&request, &profile);
        let delegation_id = delegation::delegation_id(&delegation::WORKER, &identity)?;
        if let Some(existing) = self.replay_existing(&delegation_id).await? {
            return Ok(
                json!({"ok":true,"status":"queued","relation_id":existing.relation_id,"child_session_id":existing.child_session_id,"task_id":existing.task_id}),
            );
        }
        let ids = delegation::DelegationIds::derive(&delegation::WORKER, delegation_id);
        let now = (self.now)();
        let packet = packets::worker(&ids, &request, action, &profile, reviewed, (plan, review));
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
        let intent = DispatchIntent {
            envelope,
            metadata: DispatchMetadata {
                source: "btcc-worker-delegation".into(),
            },
        };
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
