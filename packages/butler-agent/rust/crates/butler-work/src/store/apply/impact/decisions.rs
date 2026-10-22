//! Translate authored impact decisions into revision-bound reconciliation.
use super::*;
impl Batch<'_, '_> {
    pub(super) fn normalize_impacts(
        &self,
        spec: &SpecRef,
        map: Option<&ImpactMap>,
    ) -> Result<Vec<TaskImpact>> {
        match map {
            None => Ok(vec![]),
            Some(ImpactMap(decisions)) => decisions
                .iter()
                .map(|(id, decision)| {
                    if decision.reason.trim().is_empty() {
                        return Err(Error::Invalid("impact reason required"));
                    }
                    let task = self.task(id)?;
                    let expected = self.edited(id, &task)?;
                    let corrective = matches!(
                        decision.action,
                        ImpactAction::Edit | ImpactAction::Add | ImpactAction::Reverify
                    )
                    .then(|| CorrectiveDraft {
                        title: task["title"].as_str().unwrap_or_default().into(),
                        description: decision.reason.clone(),
                    });
                    Ok(TaskImpact {
                        task_id: text(&task, "id")?.into(),
                        expected_revision: expected,
                        acceptance_refs: self.revised_criteria(spec, text(&task, "id")?)?,
                        corrective,
                        action: decision.action,
                        reason: decision.reason.clone(),
                    })
                })
                .collect(),
        }
    }
    fn revised_criteria(&self, spec: &SpecRef, task: &str) -> Result<Vec<CriterionRef>> {
        let bound: Vec<CriterionRef> = rows(self.tx, sql::CRITERIA, [task])?
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()?;
        let mut retained: Vec<_> = bound
            .into_iter()
            .filter(|criterion| criterion.node_id != spec.node_id)
            .collect();
        for criterion in rows(
            self.tx,
            super::super::super::api::sql::SPEC_CRITERIA,
            params![spec.node_id, spec.revision],
        )? {
            retained.push(CriterionRef {
                node_id: spec.node_id.clone(),
                node_revision: spec.revision,
                criterion_id: text(&criterion, "criterion_id")?.into(),
            });
        }
        Ok(retained)
    }
    pub(super) fn cancel_impact(&mut self, task: &Value, reason: &str) -> Result<()> {
        if task["status"] == "completed" {
            return Ok(());
        }
        if matches!(task["status"].as_str(), Some("running" | "in_review")) {
            return Err(Error::Running);
        }
        edit_queue(
            self.tx,
            self.ctx,
            self.work()?,
            self.graph()?,
            &[QueueEdit::Delete {
                chain_id: text(task, "chain_id")?.into(),
                task_id: text(task, "id")?.into(),
            }],
        )?;
        self.tx
            .execute(sql::TASK_REASON, params![text(task, "id")?, reason])?;
        Ok(())
    }
}
