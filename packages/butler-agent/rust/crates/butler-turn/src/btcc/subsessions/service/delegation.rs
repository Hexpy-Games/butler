//! Delegation identities and the reviewed-plan checks shared by steward and
//! worker delegation.

use super::error;
use crate::btcc::{
    BtccCode, BtccError, DispatchIntent, ExecutionMode, SubsessionCreate, SubsessionPacket,
    WorkView,
};

/// Digest namespaces and id prefixes of one delegation kind. The derived ids
/// are persisted, so these strings are part of the storage format.
pub(super) struct DelegationNaming {
    delegation: &'static str,
    relation: &'static str,
    task: &'static str,
    task_prefix: &'static str,
    session: &'static str,
    session_prefix: &'static str,
    turn: &'static str,
    turn_prefix: &'static str,
}

pub(super) const STEWARD: DelegationNaming = DelegationNaming {
    delegation: "btcc.subsession.delegation.v1",
    relation: "btcc.subsession.relation.v1",
    task: "btcc.subsession.task.v1",
    task_prefix: "task",
    session: "btcc.subsession.child-session.v1",
    session_prefix: "steward",
    turn: "btcc.subsession.child-turn.v1",
    turn_prefix: "steward-turn",
};

pub(super) const WORKER: DelegationNaming = DelegationNaming {
    delegation: "btcc.worker.delegation.v1",
    relation: "btcc.worker.relation.v1",
    task: "btcc.worker.task.v1",
    task_prefix: "worker-task",
    session: "btcc.worker.session.v1",
    session_prefix: "worker",
    turn: "btcc.worker.turn.v1",
    turn_prefix: "worker-turn",
};

/// The idempotent delegation id of a request identity.
pub(super) fn delegation_id(
    naming: &DelegationNaming,
    identity: &impl serde::Serialize,
) -> Result<String, BtccError> {
    let encoded = serde_json::to_string(identity)
        .map_err(|source| error(BtccCode::SubsessionIdentityInvalid).with_source(source))?;
    Ok(format!(
        "delegation-{}",
        crate::btcc::digest_identity(&format!("{}\0{encoded}", naming.delegation))
    ))
}

/// A digest shortened to `len` characters.
fn short_digest(input: &str, len: usize) -> String {
    let digest = crate::btcc::digest_identity(input);
    digest
        .get(..len)
        .map_or_else(|| digest.clone(), str::to_owned)
}

/// The ids derived from a delegation id.
pub(super) struct DelegationIds {
    pub(super) delegation_id: String,
    pub(super) relation_id: String,
    pub(super) task_id: String,
    pub(super) child_session_id: String,
    pub(super) child_turn_id: String,
    pub(super) root_work_id: String,
}

/// The parent side of a delegation.
pub(super) struct Parent {
    pub(super) session_id: String,
    pub(super) turn_id: String,
    pub(super) anchor_message_id: String,
}

impl DelegationIds {
    pub(super) fn derive(naming: &DelegationNaming, delegation_id: String) -> Self {
        let relation_id = format!(
            "relation-{}",
            short_digest(&format!("{}\0{delegation_id}", naming.relation), 40)
        );
        let task_id = format!(
            "{}-{}",
            naming.task_prefix,
            short_digest(&format!("{}\0{delegation_id}", naming.task), 40)
        );
        let child_session_id = format!(
            "{}-{}",
            naming.session_prefix,
            short_digest(&format!("{}\0{relation_id}", naming.session), 32)
        );
        let child_turn_id = format!(
            "{}-{}",
            naming.turn_prefix,
            short_digest(&format!("{}\0{relation_id}", naming.turn), 32)
        );
        let mutation_call_id =
            format!("subsession-root-work:{delegation_id}:{task_id}:{child_session_id}");
        let root_work_id = format!(
            "guided-work-{}",
            crate::btcc::digest_identity(&format!("btcc-guided-work.v1\0work\0{mutation_call_id}"))
        );
        Self {
            delegation_id,
            relation_id,
            task_id,
            child_session_id,
            child_turn_id,
            root_work_id,
        }
    }

    pub(super) fn create(
        self,
        parent: Parent,
        safe_title: String,
        packet: SubsessionPacket,
        dispatch_intent: DispatchIntent,
        created_at: String,
    ) -> SubsessionCreate {
        SubsessionCreate {
            relation_id: self.relation_id,
            delegation_id: self.delegation_id,
            task_id: self.task_id,
            parent_session_id: parent.session_id,
            parent_turn_id: parent.turn_id,
            child_session_id: self.child_session_id,
            child_turn_id: self.child_turn_id,
            anchor_message_id: parent.anchor_message_id,
            safe_title,
            root_work_id: self.root_work_id,
            packet,
            dispatch_intent,
            created_at,
        }
    }
}

/// The reviewed plan of `mode` and its accepting review.
pub(super) fn accepted_plan(
    reviewed: &WorkView,
    mode: ExecutionMode,
    mode_code: BtccCode,
) -> Result<(&crate::btcc::WorkPlan, &crate::btcc::WorkReview), BtccError> {
    let plan = reviewed
        .current_plan
        .as_ref()
        .ok_or_else(|| error(BtccCode::DelegationReviewedPlanRequired))?;
    if plan.execution_mode != Some(mode) {
        return Err(error(mode_code));
    }
    let review = reviewed
        .latest_plan_review
        .as_ref()
        .filter(|r| {
            r.verdict == crate::btcc::ReviewVerdict::Accept
                && r.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
        })
        .ok_or_else(|| error(BtccCode::DelegationReviewedPlanRequired))?;
    Ok((plan, review))
}
