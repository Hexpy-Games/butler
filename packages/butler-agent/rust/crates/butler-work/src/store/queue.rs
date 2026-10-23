use super::*;
use crate::{
    work_chain::{Chain, Placement, Step},
    work_types::*,
};
use rusqlite::params;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct StoredChain {
    pub id: String,
    pub work_id: String,
    pub graph_revision: i64,
    pub chain: Chain,
    pub members: Vec<Value>,
}
pub fn read_task(db: &Connection, id: &str) -> Result<Value> {
    one(db, sql::TASK, [id])
}
pub fn load_chain(db: &Connection, id: &str) -> Result<StoredChain> {
    let row = one(db, sql::CHAIN, [id])?;
    let members = rows(db, sql::MEMBERS, [id])?;
    let mut steps: Vec<Step> = Vec::new();
    for member in &members {
        let index = usize::try_from(
            member["step_index"]
                .as_u64()
                .ok_or(Error::Invalid("step"))?,
        )
        .map_err(|_| Error::Invalid("step exceeds address space"))?;
        if steps.last().is_none_or(|s| s.index != index) {
            steps.push(Step {
                index,
                tasks: vec![],
            });
        }
        let step = steps.last_mut().ok_or(Error::Invalid("missing step"))?;
        if member["stack_position"].as_u64() != Some(step.tasks.len() as u64) {
            return Err(Error::Invalid("noncontiguous stack"));
        }
        step.tasks.push(TaskId(text(member, "id")?.into()));
    }
    let chain = Chain { steps };
    chain.validate()?;
    let work_id = text(&row, "work_id")?.to_owned();
    let work = read_work(db, &work_id)?;
    Ok(StoredChain {
        id: id.into(),
        work_id,
        graph_revision: work["task_graph_revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?,
        chain,
        members,
    })
}
pub(super) fn running(chains: &[&StoredChain]) -> BTreeSet<TaskId> {
    chains
        .iter()
        .flat_map(|c| &c.members)
        .filter(|m| matches!(m["status"].as_str(), Some("running" | "in_review")))
        .filter_map(|m| m["id"].as_str().map(|s| TaskId(s.into())))
        .collect()
}
pub(super) fn bump(tx: &Transaction<'_>, ctx: &Context, chain: &str, expected: i64) -> Result<()> {
    let row = one(tx, sql::CHAIN, [chain])?;
    bump_work(tx, ctx, text(&row, "work_id")?, expected)
}
pub(super) fn bump_work(
    tx: &Transaction<'_>,
    ctx: &Context,
    work: &str,
    expected: i64,
) -> Result<()> {
    cas(&read_work(tx, work)?, "task_graph_revision", expected)?;
    tx.execute(sql::BUMP_CHAIN, params![work, expected])?;
    event(tx, ctx, "task_graph", work, expected + 1, "edit")
}
fn positions(chain: &Chain) -> BTreeMap<String, (usize, usize)> {
    chain
        .steps
        .iter()
        .flat_map(|s| {
            s.tasks
                .iter()
                .enumerate()
                .map(move |(i, t)| (t.0.clone(), (s.index, i)))
        })
        .collect()
}
/// Remove every affected edge before changing membership, then derive edges.
/// Removed Tasks are cancelled before their membership is cleared.
pub(super) fn persist(
    tx: &Transaction<'_>,
    ctx: &Context,
    changes: &[(&StoredChain, &Chain)],
) -> Result<bool> {
    let mut changed = changes.iter().any(|(old, next)| old.chain != **next);
    for (old, next) in changes {
        next.validate()?;
        tx.execute(sql::DELETE_EDGES, [&old.id])?;
    }
    let mut destinations = BTreeMap::new();
    for (old, next) in changes {
        for (id, (step, stack)) in positions(next) {
            destinations.insert(id, (old.id.as_str(), step, stack));
        }
    }
    let ids: BTreeSet<_> = changes
        .iter()
        .flat_map(|(c, _)| c.members.iter().filter_map(|m| m["id"].as_str()))
        .chain(destinations.keys().map(String::as_str))
        .collect();
    for id in ids {
        let row = read_task(tx, id)?;
        let (chain, step, stack) = match destinations.get(id) {
            Some((c, s, p)) => (Some(*c), Some(*s), Some(*p)),
            None => {
                if row["status"] == "completed" {
                    return Err(Error::Invalid("completed Task cannot be deleted"));
                }
                set_state(tx, ctx, id, TaskStatus::Cancelled, None, None, None, false)?;
                (None, None, None)
            }
        };
        if row["chain_id"] != json!(chain)
            || row["step_index"] != json!(step)
            || row["stack_position"] != json!(stack)
        {
            if row["status"] == "pending" && step.is_some_and(|step| step > 0) {
                set_state(tx, ctx, id, TaskStatus::Waiting, None, None, None, false)?;
            }
            let current = read_task(tx, id)?;
            tx.execute(
                sql::MEMBERSHIP,
                params![
                    id,
                    chain,
                    step,
                    stack,
                    ctx.now,
                    current["revision"].as_i64()
                ],
            )?;
            event(
                tx,
                ctx,
                "task",
                id,
                current["revision"]
                    .as_i64()
                    .ok_or(Error::Invalid("revision"))?
                    + 1,
                "membership",
            )?;
        }
    }
    for (old, next) in changes {
        changed |= rederive_holds(tx, ctx, &old.id)?;
        for (pred, succ) in next.edges()? {
            tx.execute(sql::INSERT_EDGE, params![pred.0, succ.0, old.id])?;
        }
    }
    Ok(changed)
}
pub(super) fn update_chain_state(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let members = rows(tx, sql::MEMBERS, [id])?;
    let approvals = rows(tx, sql::DECIDED_HOLDS, [id])?;
    let mut complete = true;
    for member in &members {
        complete &= (member["status"] == "completed" && !member["result_reported_at"].is_null())
            || approval_covers(&approvals, member)?;
    }
    let state = if !undecided_holds(tx, id)?.is_empty() {
        "held"
    } else if complete {
        "done"
    } else {
        "active"
    };
    tx.execute(sql::CHAIN_STATE, params![id, state])?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct NewTask {
    pub session: TaskSession,
    pub id: String,
    pub work_id: String,
    pub title: String,
    pub spec_ref: Value,
    pub draft: bool,
    pub origin: QueueOrigin,
    pub origin_message_id: Option<String>,
}
/// Admission creates a new head or joins the step immediately after an anchor.
/// The caller supplies the new chain identity only when creating a head.
pub fn create_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &NewTask,
    expected_task_graph_revision: i64,
    chain_id: &str,
    after: Option<&str>,
) -> Result<Value> {
    let work = read_work(tx, &task.work_id)?;
    cas(&work, "task_graph_revision", expected_task_graph_revision)?;
    if matches!(work["run_state"].as_str(), Some("done" | "cancelled")) {
        return Err(Error::Invalid("terminal Work"));
    }
    let (old, next) = if let Some(anchor) = after {
        let anchor = read_task(tx, anchor)?;
        if anchor["work_id"] != task.work_id || anchor["chain_id"] != chain_id {
            return Err(Error::CrossChat);
        }
        let old = load_chain(tx, chain_id)?;
        let next = old.chain.place_after(
            TaskId(task.id.clone()),
            &TaskId(text(&anchor, "id")?.into()),
            &running(&[&old]),
        )?;
        (old, next)
    } else {
        tx.execute(sql::INSERT_CHAIN, params![chain_id, task.work_id, ctx.now])?;
        let old = load_chain(tx, chain_id)?;
        let next = Chain {
            steps: vec![Step {
                index: 0,
                tasks: vec![TaskId(task.id.clone())],
            }],
        };
        (old, next)
    };
    let (step, stack) = positions(&next)[&task.id];
    let status = if task.draft {
        "draft"
    } else if step == 0 {
        "pending"
    } else {
        "waiting"
    };
    tx.execute(
        sql::INSERT_TASK,
        params![
            task.id,
            task.work_id,
            task.spec_ref.to_string(),
            task.title,
            status,
            chain_id,
            step,
            stack,
            task.origin.as_str(),
            task.origin_message_id,
            ctx.now,
            ctx.actor.to_string()
        ],
    )?;
    reserve_task_session(tx, ctx, task)?;
    persist(tx, ctx, &[(&old, &next)])?;
    recompute_work(tx, ctx, &task.work_id)?;
    bump_work(tx, ctx, &task.work_id, expected_task_graph_revision)?;
    task_result(tx, &task.id, None)
}
#[derive(Debug, Clone)]
pub enum QueueEdit {
    MoveToNewStep {
        chain_id: String,
        task_id: String,
        index: usize,
    },
    JoinStack {
        chain_id: String,
        task_id: String,
        target: String,
    },
    SplitStack {
        chain_id: String,
        index: usize,
    },
    MoveBetween {
        chain_id: String,
        target_chain_id: String,
        task_id: String,
        placement: Placement,
    },
    Delete {
        chain_id: String,
        task_id: String,
    },
    Detach {
        chain_id: String,
        task_id: String,
        new_chain_id: String,
    },
}
impl QueueEdit {
    fn chain_id(&self) -> &str {
        match self {
            Self::MoveToNewStep { chain_id, .. }
            | Self::JoinStack { chain_id, .. }
            | Self::SplitStack { chain_id, .. }
            | Self::MoveBetween { chain_id, .. }
            | Self::Delete { chain_id, .. }
            | Self::Detach { chain_id, .. } => chain_id,
        }
    }
}
pub fn edit_queue(
    tx: &Transaction<'_>,
    ctx: &Context,
    work_id: &str,
    expected_task_graph_revision: i64,
    ops: &[QueueEdit],
) -> Result<Vec<Value>> {
    tx.execute_batch("SAVEPOINT wm_queue_batch")?;
    let result = edit_batch(tx, ctx, work_id, expected_task_graph_revision, ops);
    match result {
        Ok(questions) => {
            tx.execute_batch("RELEASE wm_queue_batch")?;
            Ok(questions)
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO wm_queue_batch; RELEASE wm_queue_batch")?;
            Err(error)
        }
    }
}
fn edit_batch(
    tx: &Transaction<'_>,
    ctx: &Context,
    work: &str,
    expected: i64,
    ops: &[QueueEdit],
) -> Result<Vec<Value>> {
    cas(&read_work(tx, work)?, "task_graph_revision", expected)?;
    let mut chains = BTreeMap::new();
    for op in ops {
        let mut ids = vec![op.chain_id()];
        if let QueueEdit::MoveBetween {
            target_chain_id, ..
        } = op
        {
            ids.push(target_chain_id);
        }
        for id in ids {
            let chain = load_chain(tx, id)?;
            if chain.work_id != work {
                return Err(Error::CrossChat);
            }
            chains.insert(id.to_owned(), chain);
        }
        if let QueueEdit::Detach { new_chain_id, .. } = op {
            tx.execute(sql::INSERT_CHAIN, params![new_chain_id, work, ctx.now])?;
            chains.insert(new_chain_id.clone(), load_chain(tx, new_chain_id)?);
        }
    }
    let mut next: BTreeMap<_, _> = chains
        .iter()
        .map(|(id, c)| (id.clone(), c.chain.clone()))
        .collect();
    let pins = running(&chains.values().collect::<Vec<_>>());
    for op in ops {
        apply_edit(tx, ctx, op, &mut next, &pins)?;
    }
    let changes: Vec<_> = chains.iter().map(|(id, old)| (old, &next[id])).collect();
    let changed = persist(tx, ctx, &changes)?;
    recompute_work(tx, ctx, work)?;
    if changed {
        bump_work(tx, ctx, work, expected)?;
    }
    let mut questions = Vec::new();
    for id in chains.keys() {
        questions.extend(undecided_holds(tx, id)?);
    }
    Ok(questions)
}
fn apply_edit(
    tx: &Transaction<'_>,
    ctx: &Context,
    op: &QueueEdit,
    next: &mut BTreeMap<String, Chain>,
    pins: &BTreeSet<TaskId>,
) -> Result<()> {
    let id = op.chain_id();
    let source = next.get(id).ok_or(Error::NotFound)?.clone();
    let edited = match op {
        QueueEdit::MoveToNewStep { task_id, index, .. } => {
            source.move_to_new_step(&TaskId(task_id.clone()), *index, pins)?
        }
        QueueEdit::JoinStack {
            task_id, target, ..
        } => source.join_stack(&TaskId(task_id.clone()), &TaskId(target.clone()), pins)?,
        QueueEdit::SplitStack { index, .. } => source.split_stack(*index, pins)?,
        QueueEdit::Delete { task_id, .. } => source.delete(&TaskId(task_id.clone()), pins)?,
        QueueEdit::MoveBetween {
            task_id,
            target_chain_id,
            placement,
            ..
        } => {
            if id == target_chain_id {
                return Err(Error::Invalid("distinct chains required"));
            }
            let target = next.get(target_chain_id).ok_or(Error::NotFound)?;
            let (source, target) =
                source.move_between(target, &TaskId(task_id.clone()), placement.clone(), pins)?;
            next.insert(target_chain_id.clone(), target);
            source
        }
        QueueEdit::Detach {
            task_id,
            new_chain_id,
            ..
        } => {
            let row = read_task(tx, task_id)?;
            if matches!(row["status"].as_str(), Some("completed" | "cancelled")) {
                return Err(Error::Invalid("terminal Task cannot detach"));
            }
            let source = source.detach(&TaskId(task_id.clone()), pins)?;
            if row["status"] != "draft" {
                set_state(
                    tx,
                    ctx,
                    task_id,
                    TaskStatus::Pending,
                    None,
                    None,
                    None,
                    false,
                )?;
            }
            next.insert(
                new_chain_id.clone(),
                Chain {
                    steps: vec![Step {
                        index: 0,
                        tasks: vec![TaskId(task_id.clone())],
                    }],
                },
            );
            tx.execute(
                sql::PROVENANCE,
                params![task_id, "detach", Option::<String>::None],
            )?;
            source
        }
    };
    next.insert(id.to_owned(), edited);
    Ok(())
}
