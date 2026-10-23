use super::*;
use crate::store::execution::sql;
use crate::{
    work_chain::Placement,
    work_types::{QueueOrigin, TaskId},
};
use std::collections::BTreeSet;

impl Batch<'_, '_> {
    pub(super) fn graph(&self) -> Result<i64> {
        read_work(self.tx, self.work()?)?["task_graph_revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))
    }
    pub(super) fn structure(&mut self, op: &Operation) -> Result<()> {
        match op {
            Operation::Add { .. } => self.add(op),
            Operation::Edit {
                task_id,
                patch,
                confirm_draft,
            } => {
                if *confirm_draft == Some(false) {
                    return Err(Error::Invalid("confirm_draft must be true when supplied"));
                }
                let task = self.task(task_id)?;
                let id = text(&task, "id")?;
                let mut patch = patch.clone();
                patch.acceptance_refs = patch
                    .acceptance_refs
                    .as_deref()
                    .map(|refs| self.criteria(refs))
                    .transpose()?;
                let updated = edit_task_fields(
                    self.tx,
                    self.ctx,
                    id,
                    self.edited(task_id, &task)?,
                    &patch,
                    confirm_draft.unwrap_or(false),
                )?;
                self.revisions.insert(id.into(), revision(&updated)?);
                Ok(())
            }
            Operation::PartAdd { .. }
            | Operation::PartEdit { .. }
            | Operation::PartRemove { .. } => self.part_structure(op),
            _ => self.queue(op),
        }
    }
    fn part_structure(&mut self, op: &Operation) -> Result<()> {
        match op {
            Operation::PartAdd {
                key,
                task_id,
                kind,
                title,
                after_part_ids,
            } => {
                let task = self.task(task_id)?;
                self.edited(task_id, &task)?;
                let id = self.id(IdKind::Part)?;
                let after = self.resolve_many(after_part_ids.as_deref().unwrap_or_default())?;
                parts::add_part(
                    self.tx,
                    self.ctx,
                    &parts::NewPart {
                        id: &id,
                        task_id: text(&task, "id")?,
                        kind: *kind,
                        title,
                        after_part_ids: &after,
                    },
                )?;
                self.remember(key.as_deref(), &id)?;
                self.revisions.insert(id, 0);
                Ok(())
            }
            Operation::PartEdit {
                part_id,
                patch,
                after_part_ids,
            } => {
                let part = self.part(part_id)?;
                let after = after_part_ids
                    .as_deref()
                    .map(|ids| self.resolve_many(ids))
                    .transpose()?;
                parts::edit_part(
                    self.tx,
                    self.ctx,
                    text(&part, "id")?,
                    self.edited(part_id, &part)?,
                    patch.title.as_deref(),
                    after.as_deref(),
                )?;
                self.revisions
                    .insert(text(&part, "id")?.into(), revision(&part)? + 1);
                Ok(())
            }
            Operation::PartRemove { part_id, reason } => {
                if reason.trim().is_empty() {
                    return Err(Error::Invalid("reason required"));
                }
                let part = self.part(part_id)?;
                parts::remove_part(
                    self.tx,
                    self.ctx,
                    text(&part, "id")?,
                    self.edited(part_id, &part)?,
                )?;
                self.revisions
                    .insert(text(&part, "id")?.into(), revision(&part)? + 1);
                Ok(())
            }
            _ => Err(Error::Invalid("not a part op")),
        }
    }
    pub(super) fn criteria(&self, refs: &[CriterionRef]) -> Result<Vec<CriterionRef>> {
        refs.iter()
            .map(|criterion| {
                Ok(CriterionRef {
                    node_id: self.resolve(&criterion.node_id)?,
                    ..criterion.clone()
                })
            })
            .collect()
    }
    fn resolve_many(&self, ids: &[String]) -> Result<Vec<String>> {
        ids.iter().map(|id| self.resolve(id)).collect()
    }
    fn task_spec(&self) -> Result<SpecRef> {
        let spec = self
            .input
            .spec_ref
            .as_ref()
            .ok_or(Error::Invalid("spec_ref required"))?;
        self.resolve_spec(spec)
    }
    fn add(&mut self, op: &Operation) -> Result<()> {
        let Operation::Add {
            run_here,
            key,
            title,
            description,
            after_task_id,
            join_step_of_task_id,
            step,
            acceptance_refs,
        } = op
        else {
            return Err(Error::Invalid("not a task.add op"));
        };
        let (after, join, step) = (
            after_task_id.as_deref(),
            join_step_of_task_id.as_deref(),
            step.as_deref(),
        );
        let criteria = acceptance_refs
            .as_deref()
            .map(|refs| self.criteria(refs))
            .transpose()?;
        placement(after, join, step)?;
        let work = self.work()?.to_owned();
        let spec = self.task_spec()?;
        let id = self.id(IdKind::Task)?;
        let after = after.map(|id| self.task(id)).transpose()?;
        let chain = after
            .as_ref()
            .map(|row| text(row, "chain_id").map(str::to_owned))
            .transpose()?
            .unwrap_or(self.id(IdKind::Chain)?);
        let task = NewTask {
            session: TaskSession::for_creation(run_here.unwrap_or(false), &self.scope.session_id),
            id: id.clone(),
            work_id: work,
            title: title.into(),
            spec_ref: serde_json::to_value(spec)?,
            draft: false,
            origin: QueueOrigin::Planner,
            origin_message_id: None,
        };
        if let Some(anchor) = join {
            let anchor = self.task(anchor)?;
            create_task_in_stack(
                self.tx,
                self.ctx,
                &task,
                self.graph()?,
                text(&anchor, "id")?,
            )?;
        } else {
            create_task(
                self.tx,
                self.ctx,
                &task,
                self.graph()?,
                &chain,
                after.as_ref().map(|row| text(row, "id")).transpose()?,
            )?;
        }
        let updated = edit_task_fields(
            self.tx,
            self.ctx,
            &id,
            revision(&read_task(self.tx, &id)?)?,
            &TaskPatch {
                title: None,
                description: Some(description.into()),
                acceptance_refs: criteria,
            },
            false,
        )?;
        self.remember(key.as_deref(), &id)?;
        self.revisions.insert(id, revision(&updated)?);
        Ok(())
    }
    fn queue(&mut self, op: &Operation) -> Result<()> {
        let (Operation::Move { task_id, .. }
        | Operation::JoinStack { task_id, .. }
        | Operation::SplitStack { task_id, .. }
        | Operation::Delete { task_id, .. }) = op
        else {
            return Err(Error::Invalid("not a structure operation"));
        };
        let task = self.task(task_id)?;
        self.edited(task_id, &task)?;
        let id = text(&task, "id")?;
        if matches!(task["status"].as_str(), Some("running" | "in_review")) {
            return Err(Error::Running);
        }
        match op {
            Operation::Move {
                after_task_id,
                join_step_of_task_id,
                step,
                ..
            } => self.place(
                id,
                after_task_id.as_deref(),
                join_step_of_task_id.as_deref(),
                step.as_deref(),
            )?,
            Operation::JoinStack {
                into_step_of_task_id,
                ..
            } => self.place(id, None, Some(into_step_of_task_id), None)?,
            Operation::SplitStack { order, .. } => self.split(&task, order.as_deref())?,
            Operation::Delete { reason, .. } => {
                if reason.trim().is_empty() {
                    return Err(Error::Invalid("reason required"));
                }
                edit_queue(
                    self.tx,
                    self.ctx,
                    self.work()?,
                    self.graph()?,
                    &[QueueEdit::Delete {
                        chain_id: text(&task, "chain_id")?.into(),
                        task_id: id.into(),
                    }],
                )?;
                self.tx
                    .execute(sql::TASK_REASON, rusqlite::params![id, reason])?;
            }
            _ => return Err(Error::Invalid("not a queue operation")),
        }
        self.revisions
            .insert(id.into(), revision(&read_task(self.tx, id)?)?);
        Ok(())
    }
    pub(super) fn place(
        &self,
        id: &str,
        after: Option<&str>,
        join: Option<&str>,
        step: Option<&str>,
    ) -> Result<()> {
        placement(after, join, step)?;
        let task = self.task(id)?;
        let source = text(&task, "chain_id")?.to_owned();
        if step.is_some() {
            edit_queue(
                self.tx,
                self.ctx,
                self.work()?,
                self.graph()?,
                &[QueueEdit::Detach {
                    chain_id: source,
                    task_id: id.into(),
                    new_chain_id: self.id(IdKind::Chain)?,
                }],
            )?;
            return Ok(());
        }
        let target = self.task(after.or(join).ok_or(Error::Invalid("placement required"))?)?;
        if target["id"] == id {
            return Err(Error::Invalid("self placement"));
        }
        let chain = load_chain(self.tx, text(&target, "chain_id")?)?;
        let target_id = text(&target, "id")?;
        let index = usize::try_from(
            target["step_index"]
                .as_u64()
                .ok_or(Error::Invalid("step"))?,
        )
        .map_err(|_| Error::Invalid("step"))?;
        let destination = if join.is_some() {
            Placement::Stack(TaskId(target_id.into()))
        } else if let Some(next) = chain.chain.steps.get(index + 1) {
            let anchor = next.tasks.iter().find(|task| task.0 != id);
            match anchor {
                Some(anchor) => Placement::Stack(anchor.clone()),
                None => return Ok(()),
            }
        } else {
            Placement::NewStep(chain.chain.steps.len())
        };
        let op = if source == chain.id {
            match destination {
                Placement::Stack(target) => QueueEdit::JoinStack {
                    chain_id: source,
                    task_id: id.into(),
                    target: target.0,
                },
                Placement::NewStep(index) => {
                    let old_step =
                        usize::try_from(task["step_index"].as_u64().ok_or(Error::Invalid("step"))?)
                            .map_err(|_| Error::Invalid("step"))?;
                    let removed = usize::from(chain.chain.steps[old_step].tasks.len() == 1);
                    QueueEdit::MoveToNewStep {
                        chain_id: source,
                        task_id: id.into(),
                        index: index - removed,
                    }
                }
            }
        } else {
            QueueEdit::MoveBetween {
                chain_id: source,
                target_chain_id: chain.id,
                task_id: id.into(),
                placement: destination,
            }
        };
        edit_queue(self.tx, self.ctx, self.work()?, self.graph()?, &[op])?;
        Ok(())
    }
    fn split(&self, task: &Value, order: Option<&[String]>) -> Result<()> {
        let chain = load_chain(self.tx, text(task, "chain_id")?)?;
        let index = usize::try_from(task["step_index"].as_u64().ok_or(Error::Invalid("step"))?)
            .map_err(|_| Error::Invalid("step"))?;
        let members = &chain.chain.steps[index].tasks;
        let pins = running(&[&chain]);
        if members.iter().any(|task| pins.contains(task)) {
            return Err(Error::Running);
        }
        let mut next = chain.chain.split_stack(index, &pins)?;
        if let Some(order) = order {
            let order = self.resolve_many(order)?;
            let expected: BTreeSet<_> = members.iter().map(|task| task.0.clone()).collect();
            if order.len() != members.len()
                || order.iter().cloned().collect::<BTreeSet<_>>() != expected
            {
                return Err(Error::Invalid(
                    "order must name every stack Task exactly once",
                ));
            }
            for (offset, id) in order.into_iter().enumerate() {
                next.steps[index + offset].tasks = vec![TaskId(id)];
            }
        }
        persist(self.tx, self.ctx, &[(&chain, &next)])?;
        super::super::queue::bump_work(self.tx, self.ctx, self.work()?, self.graph()?)
    }
}
fn placement(after: Option<&str>, join: Option<&str>, step: Option<&str>) -> Result<()> {
    if usize::from(after.is_some()) + usize::from(join.is_some()) + usize::from(step.is_some()) != 1
        || step.is_some_and(|value| value != "new")
    {
        return Err(Error::Invalid("placement_ambiguous"));
    }
    Ok(())
}
