//! Typed delegation identities and their parent Work binding.
use super::*;

/// The request identity a steward delegation id is derived from (persisted
/// through the id, so its field order is part of the format).
#[derive(serde::Serialize)]
pub(in crate::btcc::subsessions::service) struct StewardIdentity<'a> {
    pub(in crate::btcc::subsessions::service) parent_session_id: &'a str,
    pub(in crate::btcc::subsessions::service) parent_turn_id: &'a str,
    pub(in crate::btcc::subsessions::service) request: &'a str,
    pub(in crate::btcc::subsessions::service) work_id: &'a str,
    pub(in crate::btcc::subsessions::service) plan_revision_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::btcc::subsessions::service) review_revision_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::btcc::subsessions::service) previous_relation_id: Option<&'a str>,
}

/// The request identity a worker delegation id is derived from.
#[derive(serde::Serialize)]
pub(in crate::btcc::subsessions::service) struct WorkerIdentity<'a> {
    pub(in crate::btcc::subsessions::service) parent_session_id: &'a str,
    pub(in crate::btcc::subsessions::service) parent_turn_id: &'a str,
    pub(in crate::btcc::subsessions::service) action_key: &'a str,
    pub(in crate::btcc::subsessions::service) objective: &'a str,
    pub(in crate::btcc::subsessions::service) acceptance_criteria: &'a [String],
    pub(in crate::btcc::subsessions::service) implementation_brief: &'a str,
    pub(in crate::btcc::subsessions::service) profile_id: &'a str,
}

/// The reviewed parent Work a delegation executes.
pub(in crate::btcc::subsessions::service) fn parent_work_ref(
    reviewed: &WorkView,
    parent_turn_id: &str,
    plan: &crate::btcc::WorkPlan,
    review: Option<&crate::btcc::WorkReview>,
) -> crate::btcc::ParentWorkRef {
    crate::btcc::ParentWorkRef {
        work_id: reviewed.work_id.clone(),
        session_id: reviewed.session_id.clone(),
        turn_id: parent_turn_id.into(),
        plan_revision_id: plan.plan_revision_id.clone(),
        review_revision_id: review.map(|review| review.review_revision_id.clone()),
    }
}
