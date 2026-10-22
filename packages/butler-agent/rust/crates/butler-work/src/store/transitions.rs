use super::*;
use crate::work_types::*;
use rusqlite::params;

pub fn runtime_label(state: RunState) -> Option<CanonStatus> {
    match state {
        RunState::Running => Some(CanonStatus::InProgress),
        RunState::InReview => Some(CanonStatus::InReview),
        RunState::Blocked | RunState::Failed | RunState::Stopped => Some(CanonStatus::Blocked),
        RunState::Done => Some(CanonStatus::Done),
        RunState::Cancelled => Some(CanonStatus::Cancelled),
        RunState::Idle | RunState::Paused => None,
    }
}
#[allow(clippy::too_many_arguments, reason = "complete Task state update")]
pub(super) fn set_state(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    state: TaskStatus,
    hold: Option<(&str, &str)>,
    failure: Option<&str>,
    _label: Option<(CanonStatus, &str)>,
    reported: bool,
) -> Result<bool> {
    let row = read_task(tx, id)?;
    let result = if state == TaskStatus::Completed {
        row["result_reported_at"]
            .as_i64()
            .or(reported.then_some(ctx.now))
    } else {
        None
    };
    let failure = if state == TaskStatus::Failed {
        Some(failure.ok_or(Error::Invalid("failure reason required"))?)
    } else {
        None
    };
    let (reason, held_by) = hold.map_or((None, None), |(r, t)| (Some(r), Some(t)));
    if row["status"] == state.as_str()
        && row["result_reported_at"] == json!(result)
        && row["failure_reason"] == json!(failure)
        && row["hold_reason"] == json!(reason)
        && row["held_by_task_id"] == json!(held_by)
    {
        return Ok(false);
    }
    let revision = row["revision"].as_i64().ok_or(Error::Invalid("revision"))?;
    tx.execute(
        sql::STATE,
        params![
            id,
            state.as_str(),
            reason,
            held_by,
            failure,
            result,
            ctx.now,
            revision
        ],
    )?;
    if state == TaskStatus::Cancelled {
        tx.execute(sql::CANCEL_PARTS, [id])?;
    }
    event(tx, ctx, "task", id, revision + 1, "state")?;
    Ok(true)
}
/// Work runtime state is an aggregate; explicit terminal/control states win.
pub(super) fn recompute_work(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    let row = read_work(tx, id)?;
    if matches!(
        row["run_state"].as_str(),
        Some("done" | "cancelled" | "paused" | "stopped")
    ) {
        return Ok(());
    }
    let states = rows(tx, crate::work_queries::Query::TaskProgress.sql(), [id])?;
    let any = |status: &str| states.iter().any(|r| r["status"] == status);
    let state = if any("running") {
        RunState::Running
    } else if any("in_review") {
        RunState::InReview
    } else if any("failed") {
        RunState::Failed
    } else if any("blocked") || any("held") {
        RunState::Blocked
    } else {
        RunState::Idle
    };
    set_work_state(tx, ctx, &row, state, None)
}
fn set_work_state(
    tx: &Transaction<'_>,
    ctx: &Context,
    row: &Value,
    state: RunState,
    label: Option<CanonStatus>,
) -> Result<()> {
    let old = text(row, "run_state")?;
    let label = label.map(|s| (s, "person")).or_else(|| {
        (old != state.as_str() && row["visibility"] == "canon")
            .then(|| runtime_label(state).map(|s| (s, "runtime")))
            .flatten()
    });
    let status = label
        .map(|(s, _)| s.as_str())
        .or(row["canon_status"].as_str());
    let source = label
        .map(|(_, s)| s)
        .or(row["canon_status_source"].as_str());
    if old == state.as_str()
        && row["canon_status"] == json!(status)
        && row["canon_status_source"] == json!(source)
    {
        return Ok(());
    }
    let id = text(row, "id")?;
    let scope = (text(row, "scope_kind")?, text(row, "scope_ref")?);
    ensure_work_counts(tx, scope)?;
    let failure = (state == RunState::Failed).then_some("task_failed");
    tx.execute(
        sql::WORK_STATE,
        params![id, state.as_str(), status, source, failure, ctx.now],
    )?;
    if old != state.as_str() {
        count(tx, scope, &format!("run_state:{old}"), -1)?;
        count(tx, scope, &format!("run_state:{}", state.as_str()), 1)?;
    }
    event(
        tx,
        ctx,
        "work",
        id,
        row["revision"].as_i64().ok_or(Error::Invalid("revision"))? + 1,
        "state",
    )
}
#[allow(
    clippy::too_many_arguments,
    reason = "explicit runtime transition context"
)]
pub fn transition(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    state: TaskStatus,
    result_reported: bool,
    failure_reason: Option<&str>,
) -> Result<Value> {
    let row = read_task(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    allowed_transition(text(&row, "status")?, state)?;
    if result_reported && state != TaskStatus::Completed {
        return Err(Error::Invalid("only completed Tasks can report"));
    }
    let work = read_work(tx, text(&row, "work_id")?)?;
    if matches!(work["run_state"].as_str(), Some("done" | "cancelled")) {
        return Err(Error::Invalid("terminal Work"));
    }
    if state == TaskStatus::Running
        && matches!(row["status"].as_str(), Some("pending" | "waiting"))
        && !ready_tasks(tx, text(&row, "chain_id")?)?
            .iter()
            .any(|t| t == id)
    {
        return Err(Error::Invalid("predecessor barrier is not satisfied"));
    }
    let changed = set_state(
        tx,
        ctx,
        id,
        state,
        None,
        failure_reason,
        None,
        result_reported,
    )?;
    if changed {
        let chain = load_chain(tx, text(&row, "chain_id")?)?;
        if state == TaskStatus::Cancelled {
            leave_cancelled(tx, ctx, id, &chain)?;
        } else {
            rederive_holds(tx, ctx, &chain.id)?;
        }
        recompute_work(tx, ctx, &chain.work_id)?;
        bump(tx, ctx, &chain.id, chain.graph_revision)?;
    }
    task_result(tx, id, row["chain_id"].as_str())
}
pub(super) fn leave_cancelled(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    old: &StoredChain,
) -> Result<()> {
    let mut pins = running(&[old]);
    pins.remove(&TaskId(id.into()));
    let next = old.chain.delete(&TaskId(id.into()), &pins)?;
    persist(tx, ctx, &[(old, &next)])
}
pub fn set_label(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    label: CanonStatus,
    person: &UserAct,
    expected_task_graph_revision: Option<i64>,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    if row["visibility"] != "canon" {
        return Err(Error::Invalid("private Work has no canon label"));
    }
    if label == CanonStatus::Done
        && matches!(row["run_state"].as_str(), Some("running" | "in_review"))
    {
        return Err(Error::Running);
    }
    let terminal = matches!(label, CanonStatus::Done | CanonStatus::Cancelled);
    if terminal {
        cas(
            &row,
            "task_graph_revision",
            expected_task_graph_revision.ok_or(Error::Invalid("task graph revision required"))?,
        )?;
        cancel_tasks(
            tx,
            ctx,
            id,
            &format!("marked {} by {}", label.as_str(), person.person()),
        )?;
    }
    let current = text(&row, "run_state")?
        .parse()
        .map_err(|_| Error::Invalid("run state"))?;
    let state = match label {
        CanonStatus::Done => RunState::Done,
        CanonStatus::Cancelled => RunState::Cancelled,
        _ => current,
    };
    set_work_state(tx, ctx, &read_work(tx, id)?, state, Some(label))?;
    if terminal {
        super::queue::bump_work(
            tx,
            ctx,
            id,
            row["task_graph_revision"]
                .as_i64()
                .ok_or(Error::Invalid("revision"))?,
        )?;
    }
    read_work(tx, id)
}
pub(super) fn cancel_tasks(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    reason: &str,
) -> Result<()> {
    let tasks = rows(tx, sql::TASKS, [id])?;
    for task in &tasks {
        let task_id = text(task, "id")?;
        tx.execute(
            sql::CANCEL_TASK,
            params![task_id, reason, ctx.now, task["revision"].as_i64()],
        )?;
        tx.execute(sql::CANCEL_PARTS, [task_id])?;
        event(
            tx,
            ctx,
            "task",
            task_id,
            task["revision"]
                .as_i64()
                .ok_or(Error::Invalid("revision"))?
                + 1,
            "cancel",
        )?;
    }
    let chains = rows(tx, api::sql::CHAINS, [id])?;
    for chain in chains {
        let old = load_chain(tx, text(&chain, "id")?)?;
        let mut next = old.chain.clone();
        for task in &tasks {
            if task["chain_id"] == old.id {
                next = next.delete(&TaskId(text(task, "id")?.into()), &Default::default())?;
            }
        }
        persist(tx, ctx, &[(&old, &next)])?;
    }
    Ok(())
}
/// Projection only: drafts cannot pass admission and every predecessor must report.
pub fn ready_tasks(db: &Connection, chain_id: &str) -> Result<Vec<String>> {
    let chain = load_chain(db, chain_id)?;
    let approvals = rows(db, sql::DECIDED_HOLDS, [chain_id])?;
    let mut ready = Vec::new();
    for member in &chain.members {
        if !matches!(member["status"].as_str(), Some("pending" | "waiting")) {
            continue;
        }
        let step = member["step_index"]
            .as_i64()
            .ok_or(Error::Invalid("step"))?;
        let mut satisfied = true;
        for pred in chain
            .members
            .iter()
            .filter(|p| p["step_index"].as_i64() == step.checked_sub(1))
        {
            satisfied &= (pred["status"] == "completed" && !pred["result_reported_at"].is_null())
                || approval_covers(&approvals, pred)?;
        }
        if satisfied {
            ready.push(text(member, "id")?.into());
        }
    }
    Ok(ready)
}
fn allowed_transition(from: &str, to: TaskStatus) -> Result<()> {
    use TaskStatus::{
        Blocked, Cancelled, Completed, Draft, Failed, Held, InReview, Paused, Pending, Running,
        Stopped, Waiting,
    };
    let allowed: &[&str] = match to {
        Draft | Held => &[],
        Pending => &[
            "draft",
            "pending",
            "running",
            "in_review",
            "paused",
            "blocked",
            "stopped",
            "failed",
        ],
        Waiting => &["draft", "waiting", "pending"],
        Running => &[
            "pending", "waiting", "running", "failed", "stopped", "paused", "blocked",
        ],
        InReview => &["running", "in_review"],
        Blocked => &["running", "in_review", "blocked"],
        Paused => &["running", "in_review", "blocked", "paused"],
        Failed => &["running", "in_review", "failed"],
        Stopped => &["running", "in_review", "paused", "blocked", "stopped"],
        Completed => &["running", "in_review", "completed"],
        Cancelled => &[
            "draft",
            "waiting",
            "pending",
            "running",
            "in_review",
            "held",
            "paused",
            "blocked",
            "failed",
            "stopped",
            "cancelled",
        ],
    };
    if allowed.contains(&from) {
        Ok(())
    } else {
        Err(Error::Invalid("runtime transition is not allowed"))
    }
}
