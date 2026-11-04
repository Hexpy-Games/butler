//! Optional plan subjects preserve the legacy wire and diagnostic formats.
use super::view::WorkPlan;
use crate::btcc::work::PlanSubject;
use serde::Deserialize;
use std::fmt;

pub(super) fn subjects<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<PlanSubject>, D::Error> {
    Option::<Vec<PlanSubject>>::deserialize(deserializer).map(Option::unwrap_or_default)
}

impl fmt::Debug for WorkPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut plan = formatter.debug_struct("WorkPlan");
        if !self.subjects.is_empty() {
            plan.field("subjects", &self.subjects);
        }
        plan.field("plan_revision_id", &self.plan_revision_id)
            .field("revision", &self.revision)
            .field("objective", &self.objective)
            .field("governing_refs", &self.governing_refs)
            .field("execution_mode", &self.execution_mode)
            .field("actions", &self.actions)
            .field("checks", &self.checks)
            .field("origin_turn_id", &self.origin_turn_id)
            .field("created_at", &self.created_at)
            .finish()
    }
}
