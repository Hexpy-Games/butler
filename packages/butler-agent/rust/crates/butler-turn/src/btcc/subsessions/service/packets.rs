//! The persisted delegation packets and identities of steward and worker
//! delegations (their field values; the record types own the format).

use super::delegation::DelegationIds;
use super::helpers::{
    StewardIdentity, WorkerIdentity, allowed_effects, mutation_scope, parent_work_ref,
};
use super::{StewardDelegationRequest, WorkerDelegationRequest, WorkerProfile};
use crate::btcc::{
    ChildRole, PacketExecutionMode, PlanAction, SubsessionPacket, WorkPlan, WorkReview, WorkView,
};

/// The accepted plan of a delegation and its review.
pub(super) type Reviewed<'a> = (&'a WorkPlan, &'a WorkReview);

/// The identity a steward delegation id derives from.
pub(super) fn steward_identity<'a>(
    request: &'a StewardDelegationRequest,
    reviewed: &'a WorkView,
    (plan, review): Reviewed<'a>,
) -> StewardIdentity<'a> {
    StewardIdentity {
        parent_session_id: &request.parent_session_id,
        parent_turn_id: &request.parent_turn_id,
        request: &request.request,
        work_id: &reviewed.work_id,
        plan_revision_id: &plan.plan_revision_id,
        review_revision_id: &review.review_revision_id,
    }
}

/// The identity a worker delegation id derives from.
pub(super) fn worker_identity<'a>(
    request: &'a WorkerDelegationRequest,
    profile: &'a WorkerProfile,
) -> WorkerIdentity<'a> {
    WorkerIdentity {
        parent_session_id: &request.parent_session_id,
        parent_turn_id: &request.parent_turn_id,
        action_key: &request.action_key,
        objective: &request.objective,
        acceptance_criteria: &request.acceptance_criteria,
        implementation_brief: &request.implementation_brief,
        profile_id: &profile.id,
    }
}

/// The packet of a steward delegation.
pub(super) fn steward(
    ids: &DelegationIds,
    request: &StewardDelegationRequest,
    parent_chat_id: String,
    reviewed: &WorkView,
    (plan, review): Reviewed<'_>,
) -> SubsessionPacket {
    SubsessionPacket {
        child_role: ChildRole::Steward,
        delegation_id: ids.delegation_id.clone(),
        source_tool_call_id: None,
        task_id: ids.task_id.clone(),
        parent_session_id: request.parent_session_id.clone(),
        parent_turn_id: request.parent_turn_id.clone(),
        parent_chat_id: Some(parent_chat_id),
        relation_id: ids.relation_id.clone(),
        access_mode: request.access_mode.clone(),
        execution_mode: PacketExecutionMode::for_access(&request.access_mode),
        objective: request.request.clone(),
        acceptance_criteria: plan.checks.clone(),
        implementation_brief: None,
        plan_action: None,
        task_or_plan_refs: vec![plan.plan_revision_id.clone()],
        constraints_and_non_goals: Vec::new(),
        allowed_tools_and_effects: allowed_effects(&request.access_mode),
        mutation_scope: mutation_scope(&request.access_mode),
        parent_work_ref: Some(parent_work_ref(
            reviewed,
            &request.parent_turn_id,
            plan,
            review,
        )),
        worker_profile: None,
        model_ref: request.model_ref.clone(),
        reasoning_effort: request.reasoning_effort.clone(),
    }
}

/// The packet of a worker delegation.
pub(super) fn worker(
    ids: &DelegationIds,
    request: &WorkerDelegationRequest,
    action: &PlanAction,
    profile: &WorkerProfile,
    reviewed: &WorkView,
    (plan, review): Reviewed<'_>,
) -> SubsessionPacket {
    SubsessionPacket {
        child_role: ChildRole::Worker,
        delegation_id: ids.delegation_id.clone(),
        source_tool_call_id: Some(request.source_tool_call_id.clone()),
        task_id: ids.task_id.clone(),
        parent_session_id: request.parent_session_id.clone(),
        parent_turn_id: request.parent_turn_id.clone(),
        parent_chat_id: None,
        relation_id: ids.relation_id.clone(),
        access_mode: request.access_mode.clone(),
        execution_mode: PacketExecutionMode::for_access(&request.access_mode),
        objective: request.objective.clone(),
        acceptance_criteria: request.acceptance_criteria.clone(),
        implementation_brief: Some(request.implementation_brief.clone()),
        plan_action: Some(crate::btcc::PacketPlanAction {
            action_key: action.action_key.clone(),
            description: action.description.clone(),
            dependency_keys: action.dependency_keys.clone(),
        }),
        task_or_plan_refs: vec![plan.plan_revision_id.clone()],
        constraints_and_non_goals: vec![
            "Execute only this bounded Task and report to the Steward.".into(),
        ],
        allowed_tools_and_effects: allowed_effects(&request.access_mode),
        mutation_scope: mutation_scope(&request.access_mode),
        parent_work_ref: Some(parent_work_ref(
            reviewed,
            &request.parent_turn_id,
            plan,
            review,
        )),
        worker_profile: Some(crate::btcc::PacketWorkerProfile {
            id: profile.id.clone(),
            job: profile.job.clone(),
        }),
        model_ref: profile.model_ref.clone(),
        reasoning_effort: profile.reasoning_effort.clone(),
    }
}
