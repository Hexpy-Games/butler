//! One model batch, one writer transaction. The host binds scope and tier.
mod bootstrap;
mod impact;
mod receipt;
pub use receipt::apply_tool;
pub use receipt::sql as receipt_sql;
mod structure;
use super::{execution::*, tool_ops::*, *};
use crate::work_ids::{IdGenerator, IdKind};
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct ApplyScope {
    pub session_id: String,
    pub turn_id: String,
    pub instruction_id: String,
    pub work_id: Option<String>,
    pub tier: u8,
    pub planning: bool,
    /// Deterministic facts captured by the authenticated admission boundary.
    pub floors: tiers::Floors,
    /// Child-session completion is reported only by the parent's delivery.
    pub child_session: bool,
}
struct Batch<'a, 'conn> {
    tx: &'a Transaction<'conn>,
    ctx: &'a Context,
    scope: &'a ApplyScope,
    input: &'a Apply,
    work: Option<String>,
    keys: BTreeMap<String, String>,
    revisions: BTreeMap<String, i64>,
    operation_ids: Vec<String>,
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &Context,
    scope: &ApplyScope,
    input: &Apply,
) -> Result<Value> {
    apply_with_context(tx, ctx, scope, input, &mut None)
}
fn apply_with_context(
    tx: &Transaction<'_>,
    ctx: &Context,
    scope: &ApplyScope,
    input: &Apply,
    failed: &mut Option<Operation>,
) -> Result<Value> {
    let scope = tiers::selected_scope(tx, scope, input)?;
    tx.execute_batch("SAVEPOINT wm_apply")?;
    let result = apply_batch(tx, ctx, &scope, input, failed);
    match result {
        Ok(value) => {
            tx.execute_batch("RELEASE wm_apply")?;
            Ok(value)
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO wm_apply; RELEASE wm_apply")?;
            Err(error)
        }
    }
}
fn apply_batch(
    tx: &Transaction<'_>,
    ctx: &Context,
    scope: &ApplyScope,
    input: &Apply,
    failed: &mut Option<Operation>,
) -> Result<Value> {
    if !(1..=2).contains(&scope.tier) {
        return Err(Error::Invalid("Work tools require Tier 1 or Tier 2"));
    }
    if input.reason.trim().is_empty() || input.operations.is_empty() {
        return Err(Error::Invalid("reason and operations required"));
    }
    if scope.tier == 1
        && scope.work_id.is_none()
        && !input
            .operations
            .iter()
            .any(|op| matches!(op, Operation::Start { .. }))
    {
        return Err(Error::Invalid(
            "Tier 1 bootstrap must start its first Task in the same batch",
        ));
    }
    let mut batch = Batch {
        tx,
        ctx,
        scope,
        input,
        work: scope.work_id.clone(),
        keys: BTreeMap::new(),
        revisions: BTreeMap::new(),
        operation_ids: Vec::new(),
    };
    batch.preflight()?;
    for op in &input.operations {
        *failed = Some(op.clone());
        batch.perform(op)?;
        *failed = None;
        let id = batch.id(IdKind::Operation)?;
        event(tx, ctx, "operation", &id, 0, "work_apply")?;
        batch.operation_ids.push(id);
    }
    let work_id = batch
        .work
        .as_deref()
        .ok_or(Error::Invalid("no bound Work"))?;
    tiers::admit(
        tx,
        ctx,
        &scope.session_id,
        work_id,
        scope.tier,
        &input.reason,
    )?;
    for op in &input.operations {
        if let Operation::Start { task_id } = op {
            tiers::bind_started_task(tx, &scope.session_id, &batch.resolve(task_id)?)?;
        }
    }
    let work = read_work(tx, work_id)?;
    batch.revisions.insert(work_id.into(), revision(&work)?);
    Ok(
        json!({"ok":true,"operation_ids":batch.operation_ids,"keys":batch.keys,
        "entity_revisions":batch.revisions,"task_graph_revision":work["task_graph_revision"],
        "changed":true,"remaining":0,"work":work}),
    )
}
impl Batch<'_, '_> {
    fn preflight(&self) -> Result<()> {
        if let Some(work) = &self.work {
            let work = read_work(self.tx, work)?;
            if self.input.operations.iter().any(Operation::structure) {
                cas(
                    &work,
                    "task_graph_revision",
                    self.input
                        .expected_task_graph_revision
                        .ok_or(Error::Invalid("expected_task_graph_revision required"))?,
                )?;
            }
            let spec = self
                .input
                .spec_ref
                .as_ref()
                .ok_or(Error::Invalid("spec_ref required"))?;
            self.validate_spec(spec)?;
        }
        for (id, expected) in &self.input.expected_revisions {
            let row = read_task(self.tx, id)
                .or_else(|error| match error {
                    Error::NotFound => parts::read_part(self.tx, id),
                    other => Err(other),
                })
                .or_else(|error| match error {
                    Error::NotFound => one(self.tx, super::sql::NODE, [id]),
                    other => Err(other),
                })?;
            cas(&row, "revision", *expected)?;
        }
        Ok(())
    }
    fn id(&self, kind: IdKind) -> Result<String> {
        Ok(IdGenerator::global_next(kind, self.ctx.now)?)
    }
    fn resolve(&self, id: &str) -> Result<String> {
        match id.strip_prefix('@') {
            Some(key) => self
                .keys
                .get(key)
                .cloned()
                .ok_or(Error::Invalid("unknown @key")),
            None => Ok(id.into()),
        }
    }
    fn work(&self) -> Result<&str> {
        self.work.as_deref().ok_or(Error::Invalid("no bound Work"))
    }
    fn task(&self, id: &str) -> Result<Value> {
        let row = read_task(self.tx, &self.resolve(id)?)?;
        if row["work_id"] != self.work()? {
            return Err(Error::NotFound);
        }
        Ok(row)
    }
    fn part(&self, id: &str) -> Result<Value> {
        let part = parts::read_part(self.tx, &self.resolve(id)?)?;
        self.task(text(&part, "task_id")?)?;
        Ok(part)
    }
    fn edited(&self, id: &str, row: &Value) -> Result<i64> {
        if !id.starts_with('@') && !self.input.expected_revisions.contains_key(id) {
            return Err(Error::Invalid(
                "expected_revisions required for edited entity",
            ));
        }
        revision(row)
    }
    fn remember(&mut self, key: Option<&str>, id: &str) -> Result<()> {
        if let Some(key) = key {
            if key.is_empty() || self.keys.contains_key(key) {
                return Err(Error::Invalid("duplicate or empty key"));
            }
            self.keys.insert(key.into(), id.into());
        }
        Ok(())
    }
    fn resolve_spec(&self, spec: &SpecRef) -> Result<SpecRef> {
        let node_id = self.resolve(&spec.node_id)?;
        let body_hash = if spec.body_hash.starts_with('@') {
            if self.resolve(&spec.body_hash)? != node_id {
                return Err(Error::Invalid("Spec publication key mismatch"));
            }
            let row = one(
                self.tx,
                super::sql::SPEC_REVISION,
                rusqlite::params![node_id, spec.revision],
            )?;
            text(&row, "body_hash")?.to_owned()
        } else {
            spec.body_hash.clone()
        };
        Ok(SpecRef {
            node_id,
            revision: spec.revision,
            body_hash,
        })
    }
    fn validate_spec(&self, spec: &SpecRef) -> Result<Value> {
        let spec = self.resolve_spec(spec)?;
        let node = one(self.tx, super::sql::NODE, [&spec.node_id])?;
        if self.work.is_some() && node["work_id"] != self.work()? {
            return Err(Error::Invalid("Spec outside bound Work"));
        }
        let published = one(
            self.tx,
            super::sql::SPEC_REVISION,
            rusqlite::params![spec.node_id, spec.revision],
        )?;
        if published["body_hash"] != spec.body_hash {
            return Err(Error::Invalid("Spec hash mismatch"));
        }
        Ok(node)
    }
    fn execution_scope(&self) -> ExecutionScope<'_> {
        ExecutionScope {
            session_id: &self.scope.session_id,
            turn_id: &self.scope.turn_id,
        }
    }
    fn perform(&mut self, op: &Operation) -> Result<()> {
        let graph = self.work.as_ref().map(|_| self.graph()).transpose()?;
        if self.scope.tier == 1
            && self.scope.work_id.is_none()
            && !matches!(
                op,
                Operation::CreateLight { .. } | Operation::Add { .. } | Operation::Start { .. }
            )
        {
            return Err(Error::Invalid(
                "Only work.create_light, task.add and task.start are available before Tier 1 bootstrap commits",
            ));
        }
        if self.scope.planning && op.execution() {
            return Err(Error::Invalid("execution is hidden during planning"));
        }
        if self.scope.tier == 1
            && matches!(
                op,
                Operation::JoinStack { .. } | Operation::SplitStack { .. }
            )
        {
            return Err(Error::Invalid("operation is hidden at Tier 1"));
        }
        let added = match op {
            Operation::CreateLight { tasks, .. } => tasks.iter().map(Vec::len).sum(),
            Operation::Add { .. } => 1,
            _ => 0,
        };
        tiers::check_floor(
            self.tx,
            self.work.as_deref(),
            self.scope.tier,
            added,
            self.scope.floors,
        )?;
        if self.scope.tier == 2 && matches!(op, Operation::Start { .. }) {
            tiers::ensure_detail(self.tx, self.work()?)?;
            tiers::ensure_coverage(self.tx, self.work()?)?;
        }
        match op {
            Operation::CreateLight {
                tier: _,
                key,
                goal,
                done_criteria,
                tasks,
            } => self.bootstrap(key.as_deref(), goal, done_criteria, tasks),
            Operation::Escalate { .. } => Ok(()),
            Operation::Add { .. }
            | Operation::Edit { .. }
            | Operation::Move { .. }
            | Operation::JoinStack { .. }
            | Operation::SplitStack { .. }
            | Operation::Delete { .. }
            | Operation::PartAdd { .. }
            | Operation::PartEdit { .. }
            | Operation::PartRemove { .. } => self.structure(op),
            Operation::Propose { .. } | Operation::Activate { .. } => self.spec(op),
            _ => self.execute(op),
        }?;
        if op.structure()
            && let Some(graph) = graph
            && self.graph()? == graph
        {
            super::queue::bump_work(self.tx, self.ctx, self.work()?, graph)?;
        }
        Ok(())
    }
    fn execute(&mut self, op: &Operation) -> Result<()> {
        if matches!(op, Operation::Complete { .. } | Operation::Submit { .. })
            && let Some(hold) = control::active_holds(self.tx, &self.scope.session_id)?.first()
        {
            return Err(Error::Conflict {
                current: json!({"instruction_id":hold["id"]}),
            });
        }
        if matches!(op, Operation::Complete { .. } | Operation::Submit { .. })
            && let Some(instruction) =
                control::next_pending(self.tx, &self.scope.session_id, true)?.first()
        {
            return Err(Error::Conflict {
                current: json!({"instruction_id":instruction["id"]}),
            });
        }
        let (task_id, part_id) = self.execution_target(op)?;
        if matches!(
            op,
            Operation::Start { .. } | Operation::PartStart { .. } | Operation::Submit { .. }
        ) {
            self.start_or_submit(op, &task_id, part_id.as_deref())?;
        } else {
            self.settle(op, &task_id)?;
        }
        let current = revision(&read_task(self.tx, &task_id)?)?;
        self.revisions.insert(task_id, current);
        Ok(())
    }
    fn execution_target(&self, op: &Operation) -> Result<(String, Option<String>)> {
        Ok(match op {
            Operation::PartStart { part_id } => {
                let row = self.part(part_id)?;
                (
                    text(&row, "task_id")?.into(),
                    Some(text(&row, "id")?.to_owned()),
                )
            }
            Operation::Start { task_id }
            | Operation::Submit { task_id, .. }
            | Operation::Review { task_id, .. }
            | Operation::Complete { task_id, .. }
            | Operation::Block { task_id, .. }
            | Operation::Fail { task_id, .. } => {
                let row = self.task(task_id)?;
                (text(&row, "id")?.to_owned(), None)
            }
            _ => return Err(Error::Invalid("not an execution op")),
        })
    }
    fn start_or_submit(&self, op: &Operation, id: &str, part_id: Option<&str>) -> Result<()> {
        let scope = self.execution_scope();
        match op {
            Operation::Start { .. } => {
                start_task(
                    self.tx,
                    self.ctx,
                    id,
                    revision(&read_task(self.tx, id)?)?,
                    &scope,
                    &self.id(IdKind::Attempt)?,
                )?;
            }
            Operation::PartStart { .. } => {
                let part = part_id.ok_or(Error::Invalid("part id"))?;
                start_part(
                    self.tx,
                    self.ctx,
                    part,
                    revision(&parts::read_part(self.tx, part)?)?,
                    &scope,
                    &self.id(IdKind::Attempt)?,
                )?;
            }
            Operation::Submit {
                part_id,
                result_refs,
                evidence_refs,
                ..
            } => {
                let part = part_id.as_ref().map(|p| self.resolve(p)).transpose()?;
                submit_task(
                    self.tx,
                    self.ctx,
                    id,
                    &scope,
                    &Submission {
                        part_id: part.as_deref(),
                        result_id: &self.id(IdKind::Result)?,
                        result_refs,
                        evidence_refs,
                    },
                )?;
            }
            _ => return Err(Error::Invalid("not a start/submit op")),
        }
        Ok(())
    }
    fn settle(&mut self, op: &Operation, id: &str) -> Result<()> {
        match op {
            Operation::Review {
                key,
                result_revision,
                verdict,
                criterion_results,
                ..
            } => {
                let review = self.id(IdKind::Review)?;
                review_task(
                    self.tx,
                    self.ctx,
                    id,
                    &self.scope.session_id,
                    &ReviewInput {
                        result_revision: *result_revision,
                        review_id: &review,
                        accept: matches!(verdict, Verdict::Accept),
                        judgments: criterion_results,
                    },
                )?;
                self.remember(key.as_deref(), &review)?;
            }
            Operation::Complete { review_ref, .. } => {
                complete_task(
                    self.tx,
                    self.ctx,
                    id,
                    &self.scope.session_id,
                    &self.resolve(review_ref)?,
                    !self.scope.child_session,
                )?;
            }
            Operation::Block {
                part_id,
                reason,
                checkpoint_ref,
                ..
            } => {
                let part = part_id.as_ref().map(|p| self.resolve(p)).transpose()?;
                block_task(
                    self.tx,
                    self.ctx,
                    id,
                    part.as_deref(),
                    &self.scope.session_id,
                    reason,
                    checkpoint_ref.as_deref(),
                )?;
            }
            Operation::Fail { reason, .. } => {
                fail_task(self.tx, self.ctx, id, &self.scope.session_id, reason)?;
            }
            _ => return Err(Error::Invalid("not an execution op")),
        }
        Ok(())
    }
}
