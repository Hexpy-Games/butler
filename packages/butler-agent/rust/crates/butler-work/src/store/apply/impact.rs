//! Reconcile exact Spec bindings without rewriting completed Task history.
use super::*;
use crate::store::execution::sql;
use crate::work_types::QueueOrigin;
use rusqlite::params;
use std::collections::{BTreeMap, BTreeSet};

impl Batch<'_, '_> {
    pub(super) fn activate_publications(
        &mut self,
        refs: &[SpecRef],
        map: Option<&ImpactMap>,
    ) -> Result<()> {
        let mut prepared = Vec::new();
        let mut nodes = BTreeSet::new();
        let mut impacts = BTreeMap::<String, (SpecRef, TaskImpact)>::new();
        let work = read_work(self.tx, self.work()?)?;
        for spec in refs {
            let spec = self.resolve_spec(spec)?;
            if !nodes.insert(spec.node_id.clone()) {
                return Err(Error::Invalid("duplicate Spec activation"));
            }
            let node = self.validate_spec(&spec)?;
            if self.scope.tier == 1 && work["spec_node_id"] != spec.node_id {
                return Err(Error::Invalid("Tier 1 can author only the brief node"));
            }
            for impact in self.spec_impacts(&spec, map)? {
                let task = self.task(&impact.task_id)?;
                let bound: SpecRef = serde_json::from_str(text(&task, "spec_ref")?)?;
                if !impacts.contains_key(&impact.task_id) || bound.node_id == spec.node_id {
                    impacts.insert(impact.task_id.clone(), (spec.clone(), impact));
                }
            }
            prepared.push((spec, node));
        }
        if let Some(map) = map {
            for impact in &map.tasks {
                if !impacts.contains_key(&self.resolve(&impact.task_id)?) {
                    return Err(Error::Invalid(
                        "Task impact is outside the activated revisions",
                    ));
                }
            }
        }
        // Validate the entire tree delta before changing any pointer or Task.
        for (spec, node) in prepared {
            activate_spec(
                self.tx,
                self.ctx,
                &spec.node_id,
                revision(&node)?,
                node["active_revision"].as_i64(),
                spec.revision,
            )?;
            self.revisions.insert(spec.node_id, revision(&node)? + 1);
        }
        for (_, (spec, impact)) in impacts {
            self.reconcile_impacts(&spec, &[impact])?;
        }
        Ok(())
    }
    pub(super) fn spec_impacts(
        &self,
        spec: &SpecRef,
        map: Option<&ImpactMap>,
    ) -> Result<Vec<TaskImpact>> {
        let node = self.validate_spec(spec)?;
        let Some(old) = node["active_revision"].as_i64() else {
            return Ok(vec![]);
        };
        if old == spec.revision {
            return Ok(vec![]);
        }
        let previous = rows(
            self.tx,
            super::super::api::sql::SPEC_CRITERIA,
            params![spec.node_id, old],
        )?;
        let next = rows(
            self.tx,
            super::super::api::sql::SPEC_CRITERIA,
            params![spec.node_id, spec.revision],
        )?;
        let next: BTreeMap<_, _> = next
            .iter()
            .map(|c| (c["criterion_id"].clone().to_string(), c["text"].clone()))
            .collect();
        let mut consumers = BTreeMap::<String, bool>::new();
        for criterion in previous {
            let changed =
                next.get(&criterion["criterion_id"].to_string()) != Some(&criterion["text"]);
            for consumer in rows(
                self.tx,
                crate::work_queries::Query::CriterionConsumers.sql(),
                params![spec.node_id, old, text(&criterion, "criterion_id")?],
            )? {
                let id = text(&consumer, "task_id")?.to_owned();
                *consumers.entry(id).or_default() |= changed;
            }
        }
        self.match_impacts(map, &consumers)
    }
    fn match_impacts(
        &self,
        map: Option<&ImpactMap>,
        consumers: &BTreeMap<String, bool>,
    ) -> Result<Vec<TaskImpact>> {
        let mut result = Vec::new();
        let mut seen = BTreeSet::new();
        for impact in map.map(|m| m.tasks.as_slice()).unwrap_or_default() {
            let id = self.resolve(&impact.task_id)?;
            if !seen.insert(id.clone()) {
                return Err(Error::Invalid("duplicate Task impact"));
            }
            let row = self.task(&id)?;
            if !consumers.contains_key(&id) {
                continue;
            }
            cas(&row, "revision", impact.expected_revision)?;
            if row["status"] == "cancelled" {
                continue;
            }
            if consumers[&id] && impact.corrective.is_none() {
                return Err(Error::Invalid("changed criteria require a corrective Task"));
            }
            result.push(TaskImpact {
                task_id: id,
                ..impact.clone()
            });
        }
        for id in consumers.keys() {
            if self.task(id)?["status"] != "cancelled" && !seen.contains(id) {
                return Err(Error::Invalid(
                    "Spec activation requires an impact for every bound Task",
                ));
            }
        }
        Ok(result)
    }
    pub(super) fn reconcile_impacts(
        &mut self,
        spec: &SpecRef,
        impacts: &[TaskImpact],
    ) -> Result<()> {
        for impact in impacts {
            let row = self.task(&impact.task_id)?;
            let criteria = self.criteria(&impact.acceptance_refs)?;
            if row["status"] != "completed" {
                self.rebind_task(spec, &row, &criteria)?;
            }
            if let Some(draft) = &impact.corrective {
                self.corrective_task(spec, &row, &criteria, draft)?;
            }
        }
        Ok(())
    }
    fn rebind_task(
        &mut self,
        spec: &SpecRef,
        row: &Value,
        criteria: &[CriterionRef],
    ) -> Result<()> {
        let id = text(row, "id")?;
        if matches!(row["status"].as_str(), Some("running" | "in_review")) {
            block_task(
                self.tx,
                self.ctx,
                id,
                None,
                text(row, "assignee_session_id")?,
                "Spec revision changed; reconcile and restart this Task",
                None,
            )?;
        }
        let row = read_task(self.tx, id)?;
        edit_task_fields(
            self.tx,
            self.ctx,
            id,
            revision(&row)?,
            &TaskPatch {
                title: None,
                description: None,
                acceptance_refs: Some(criteria.to_vec()),
            },
            false,
        )?;
        let row = read_task(self.tx, id)?;
        self.tx.execute(
            sql::TASK_SPEC,
            params![
                id,
                serde_json::to_string(spec)?,
                self.ctx.now,
                revision(&row)?
            ],
        )?;
        event(
            self.tx,
            self.ctx,
            "task",
            id,
            revision(&row)? + 1,
            "spec_rebound",
        )?;
        self.revisions.insert(id.into(), revision(&row)? + 1);
        Ok(())
    }
    fn corrective_task(
        &mut self,
        spec: &SpecRef,
        anchor: &Value,
        criteria: &[CriterionRef],
        draft: &CorrectiveDraft,
    ) -> Result<()> {
        tiers::check_floor(
            self.tx,
            self.work.as_deref(),
            self.scope.tier,
            1,
            self.scope.floors,
        )?;
        let id = self.id(IdKind::Task)?;
        create_task(
            self.tx,
            self.ctx,
            &NewTask {
                id: id.clone(),
                work_id: self.work()?.into(),
                title: draft.title.clone(),
                spec_ref: serde_json::to_value(spec)?,
                draft: false,
                origin: QueueOrigin::Planner,
                origin_message_id: None,
            },
            self.graph()?,
            text(anchor, "chain_id")?,
            Some(text(anchor, "id")?),
        )?;
        let row = read_task(self.tx, &id)?;
        let row = edit_task_fields(
            self.tx,
            self.ctx,
            &id,
            revision(&row)?,
            &TaskPatch {
                title: None,
                description: Some(draft.description.clone()),
                acceptance_refs: Some(criteria.to_vec()),
            },
            false,
        )?;
        self.revisions.insert(id, revision(&row)?);
        Ok(())
    }
}
