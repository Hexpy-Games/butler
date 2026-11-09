//! Canon write inputs (shared/canon-contracts.ts:123-140): plan and epic updates and orders.
use serde::Serialize;

use super::CanonStatus;

/// A nullable field of a partial update (`field?: T | null`): left out (unchanged), sent as
/// `null` (cleared), or set.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum Patch<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<T> Patch<T> {
    pub(crate) fn is_keep(&self) -> bool {
        matches!(self, Self::Keep)
    }
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:123 PlanInput
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub(crate) struct PlanInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Patch::is_keep")]
    pub(crate) due_on: Patch<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:130 EpicInput (`Patch::Clear`
/// sends null: no assignee, the backlog).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub(crate) struct EpicInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<CanonStatus>,
    #[serde(skip_serializing_if = "Patch::is_keep")]
    pub(crate) assignee: Patch<String>,
    #[serde(skip_serializing_if = "Patch::is_keep")]
    pub(crate) plan_id: Patch<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) before_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tags: Option<Vec<String>>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:140 CanonOrderInput
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct CanonOrderInput {
    pub(crate) work_ids: Vec<String>,
    pub(crate) expected_revision: i64,
}
