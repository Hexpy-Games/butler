//! One model batch, one writer transaction. The host binds scope and tier.
mod bootstrap;
mod impact;
mod receipt;
pub use receipt::apply_tool;
pub use receipt::sql as receipt_sql;
mod runtime;
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
    task_contexts: BTreeMap<String, Value>,
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
    let mut batch = Batch {
        tx,
        ctx,
        scope,
        input,
        work: scope.work_id.clone(),
        keys: BTreeMap::new(),
        revisions: BTreeMap::new(),
        operation_ids: Vec::new(),
        task_contexts: BTreeMap::new(),
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
    if work["home_session_id"] == scope.session_id
        && !scope.child_session
        && input.operations.iter().any(Operation::structure)
    {
        let person: bool = tx.query_row(
            ownership::sql::PERSON_REQUEST,
            [&scope.instruction_id],
            |r| r.get(0),
        )?;
        if person {
            batch.start_work()?;
        }
    }
    let work = read_work(tx, work_id)?;
    batch.revisions.insert(work_id.into(), revision(&work)?);
    Ok(
        json!({"ok":true,"operation_ids":batch.operation_ids,"keys":batch.keys,
        "task_contexts":batch.task_contexts,"entity_revisions":batch.revisions,"task_graph_revision":work["task_graph_revision"],
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
                run_here,
                tier: _,
                key,
                goal,
                done_criteria,
                tasks,
            } => self.bootstrap(
                key.as_deref(),
                goal,
                done_criteria,
                tasks,
                run_here.unwrap_or(false),
            ),
            Operation::Escalate { .. } => self.start_work(),
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
    fn start_work(&self) -> Result<()> {
        self.tx.execute(
            ownership::sql::START_WORK,
            rusqlite::params![self.work()?, self.ctx.now],
        )?;
        scheduler::changed(self.tx, self.ctx, "work", self.work()?)?;
        Ok(())
    }
}
