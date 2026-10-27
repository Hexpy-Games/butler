//! Exact board item facts resolved before admission.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalCanon {
    pub kind: String,
    pub title: String,
    pub project_id: String,
    pub project_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

pub(super) fn summarize(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    let mut approval = single(
        ApprovalActionKind::CreateCanon,
        ApprovalTargetKind::Project,
        facts
            .input
            .pointer("/canon/project_id")
            .and_then(Value::as_str)
            .unwrap_or(facts.target),
        ApprovalRisk::Low,
    );
    approval.canon = facts
        .input
        .get("canon")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    if let Some(canon) = &mut approval.canon {
        canon.description = facts
            .input
            .pointer("/body/description")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| canon.description.clone());
    }
    approval
}
