use super::*;
use crate::store::execution::sql;
use crate::work_types::{Origin, QueueOrigin, ScopeKind};
use rusqlite::params;

impl Batch<'_, '_> {
    pub(super) fn bootstrap(
        &mut self,
        key: Option<&str>,
        goal: &str,
        criteria: &[String],
        tasks: &[Vec<TaskDraft>],
    ) -> Result<()> {
        if self.work.is_some() {
            return Err(Error::Invalid("bootstrap is only available once"));
        }
        if !(2..=3).contains(&criteria.len()) || tasks.is_empty() || tasks.iter().any(Vec::is_empty)
        {
            return Err(Error::Invalid(
                "bootstrap requires 2..3 criteria and nonempty steps",
            ));
        }
        self.new_work(goal, goal)?;
        let work = self.work()?.to_owned();
        self.remember(key, &work)?;
        let spec = self.publish(
            None,
            None,
            &SpecDraft {
                title: goal.into(),
                goal: goal.into(),
                criteria: criteria.to_vec(),
                constraints: vec![],
            },
        )?;
        let node = self.validate_spec(&spec)?;
        activate_spec(
            self.tx,
            self.ctx,
            &spec.node_id,
            revision(&node)?,
            None,
            spec.revision,
        )?;
        self.tx
            .execute(sql::WORK_SPEC, params![work, spec.node_id, self.scope.tier])?;
        self.bootstrap_tasks(tasks, &spec, criteria.len())
    }
    fn bootstrap_tasks(
        &mut self,
        tasks: &[Vec<TaskDraft>],
        spec: &SpecRef,
        criteria_count: usize,
    ) -> Result<()> {
        let work = self.work()?.to_owned();
        let mut previous: Option<String> = None;
        for step in tasks {
            let mut first: Option<String> = None;
            for draft in step {
                let id = self.id(IdKind::Task)?;
                let chain = if let Some(anchor) = &previous {
                    text(&read_task(self.tx, anchor)?, "chain_id")?.to_owned()
                } else {
                    self.id(IdKind::Chain)?
                };
                let task = NewTask {
                    id: id.clone(),
                    work_id: work.clone(),
                    title: draft.title.clone(),
                    spec_ref: serde_json::to_value(spec)?,
                    draft: false,
                    origin: QueueOrigin::Planner,
                    origin_message_id: None,
                };
                if let Some(anchor) = previous.as_deref() {
                    create_task(
                        self.tx,
                        self.ctx,
                        &task,
                        self.graph()?,
                        &chain,
                        Some(anchor),
                    )?;
                } else if let Some(anchor) = first.as_deref() {
                    create_task_in_stack(self.tx, self.ctx, &task, self.graph()?, anchor)?;
                } else {
                    create_task(self.tx, self.ctx, &task, self.graph()?, &chain, None)?;
                }
                let indexes = draft
                    .criteria
                    .clone()
                    .unwrap_or_else(|| (0..criteria_count).collect());
                let refs = indexes
                    .into_iter()
                    .map(|index| {
                        if index >= criteria_count {
                            return Err(Error::Invalid("criterion index out of range"));
                        }
                        Ok(CriterionRef {
                            node_id: spec.node_id.clone(),
                            node_revision: spec.revision,
                            criterion_id: format!("c{index}"),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                edit_task_fields(
                    self.tx,
                    self.ctx,
                    &id,
                    revision(&read_task(self.tx, &id)?)?,
                    &TaskPatch {
                        title: None,
                        description: Some(draft.description.clone()),
                        acceptance_refs: Some(refs),
                    },
                    false,
                )?;
                self.remember(draft.key.as_deref(), &id)?;
                self.revisions
                    .insert(id.clone(), revision(&read_task(self.tx, &id)?)?);
                first.get_or_insert(id);
            }
            previous = first;
        }
        Ok(())
    }
    fn new_work(&mut self, title: &str, description: &str) -> Result<()> {
        let id = self.id(IdKind::Work)?;
        create_work(
            self.tx,
            self.ctx,
            &NewWork {
                id: id.clone(),
                scope_kind: ScopeKind::Session,
                scope_ref: self.scope.session_id.clone(),
                title: title.into(),
                description: description.into(),
                origin: Origin::Chat,
                draft: false,
            },
            &Registration::Private,
        )?;
        assign_home(self.tx, self.ctx, &id, 0, Some(&self.scope.session_id))?;
        self.work = Some(id);
        Ok(())
    }
    fn publish(
        &mut self,
        node_id: Option<&str>,
        base: Option<i64>,
        draft: &SpecDraft,
    ) -> Result<SpecRef> {
        if draft.criteria.is_empty() {
            return Err(Error::Invalid("Spec criteria required"));
        }
        if self.work.is_none() {
            if self.scope.tier != 2 {
                return Err(Error::Invalid("bootstrap required"));
            }
            self.new_work(&draft.title, &draft.goal)?;
        }
        let work = self.work()?.to_owned();
        let work_row = read_work(self.tx, &work)?;
        let id = node_id
            .map(|id| self.resolve(id))
            .transpose()?
            .unwrap_or(self.id(IdKind::Spec)?);
        let node = self.publication_node(&id, node_id, base, &work_row)?;
        let next = revision(&node)? + 1;
        one(
            self.tx,
            sql::INSTRUCTION,
            params![self.scope.instruction_id, self.scope.session_id],
        )?;
        let hash = put_body(self.tx, &serde_json::to_string(draft)?)?;
        publish_spec(
            self.tx,
            self.ctx,
            &id,
            revision(&node)?,
            &Publication {
                revision: next,
                body_hash: hash.clone(),
                parser_version: "work-tools-1".into(),
                authoring_instruction_id: Some(self.scope.instruction_id.clone()),
                criteria: draft
                    .criteria
                    .iter()
                    .enumerate()
                    .map(|(i, text)| Criterion {
                        id: format!("c{i}"),
                        part_id: id.clone(),
                        text: text.clone(),
                    })
                    .collect(),
            },
        )?;
        if work_row["spec_node_id"].is_null() {
            self.tx
                .execute(sql::WORK_SPEC, params![work, id, self.scope.tier])?;
        }
        self.revisions.insert(id.clone(), next);
        Ok(SpecRef {
            node_id: id,
            revision: next,
            body_hash: hash,
        })
    }
    fn publication_node(
        &self,
        id: &str,
        node_id: Option<&str>,
        base: Option<i64>,
        work_row: &Value,
    ) -> Result<Value> {
        let work = self.work()?.to_owned();
        match one(self.tx, super::super::sql::NODE, [id]) {
            Ok(node) => {
                if node["work_id"] != work {
                    return Err(Error::Invalid("Spec outside bound Work"));
                }
                if self.scope.tier == 1 && work_row["spec_node_id"] != id {
                    return Err(Error::Invalid("Tier 1 can author only the brief node"));
                }
                if node["active_revision"].as_i64() != base {
                    return Err(Error::Conflict { current: node });
                }
                if !self.input.expected_revisions.contains_key(id) {
                    return Err(Error::Invalid("expected_revisions required for Spec edit"));
                }
                Ok(node)
            }
            Err(Error::NotFound) if node_id.is_none() => create_spec_node(
                self.tx,
                self.ctx,
                &NewSpecNode {
                    id: id.into(),
                    scope_kind: ScopeKind::Session,
                    scope_ref: self.scope.session_id.clone(),
                    work_id: Some(work.clone()),
                    parent_node_id: work_row["spec_node_id"].as_str().map(str::to_owned),
                    concern_id: id.into(),
                },
                &Registration::Private,
            ),
            Err(error) => Err(error),
        }
    }
    pub(super) fn spec(&mut self, op: &Operation) -> Result<()> {
        match op {
            Operation::Propose {
                key,
                node_id,
                base_revision,
                node,
            } => {
                let spec = self.publish(node_id.as_deref(), *base_revision, node)?;
                self.remember(key.as_deref(), &spec.node_id)
            }
            Operation::Activate {
                published_refs,
                expected_tree_version,
                impact_map,
            } => {
                let work = read_work(self.tx, self.work()?)?;
                let tree_key = format!("spec_tree:{}", self.work()?);
                let scope = (text(&work, "scope_kind")?, text(&work, "scope_ref")?);
                let version: i64 = self
                    .tx
                    .query_row(
                        super::super::sql::COUNT_ROW,
                        params![scope.0, scope.1, tree_key],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                if version != *expected_tree_version {
                    return Err(Error::Conflict {
                        current: json!({"tree_version":version}),
                    });
                }
                self.activate_publications(published_refs, impact_map.as_ref())?;
                count(self.tx, scope, &tree_key, 1)
            }
            _ => Err(Error::Invalid("not a Spec operation")),
        }
    }
}
