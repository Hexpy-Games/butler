use super::*;
use crate::work_types::*;
use rusqlite::params;
/// Runtime changes project onto canon labels only when the runtime state changes.
pub fn runtime_label(state: RunState) -> Option<CanonStatus> {
    match state {
        RunState::Running => Some(CanonStatus::InProgress),
        RunState::InReview => Some(CanonStatus::InReview),
        RunState::Blocked | RunState::Failed | RunState::Stopped | RunState::Held => {
            Some(CanonStatus::Blocked)
        }
        RunState::Done => Some(CanonStatus::Done),
        RunState::Cancelled => Some(CanonStatus::Cancelled),
        RunState::Idle | RunState::Waiting | RunState::Paused => None,
    }
}
#[allow(clippy::too_many_arguments, reason = "internal complete state update")]
pub(super) fn set_state(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    state: RunState,
    hold: Option<(&str, &str)>,
    failure: Option<&str>,
    label: Option<(CanonStatus, &str)>,
    reported: bool,
) -> Result<bool> {
    let row = read_work(tx, id)?;
    let old = text(&row, "run_state")?;
    ensure_work_counts(tx, (text(&row, "scope_kind")?, text(&row, "scope_ref")?))?;
    let label = label.or_else(|| {
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
    let result = if state == RunState::Done {
        row["result_reported_at"]
            .as_i64()
            .or(reported.then_some(ctx.now))
    } else {
        None
    };
    let failure = if state == RunState::Failed {
        Some(failure.ok_or(Error::Invalid("failure reason required"))?)
    } else {
        None
    };
    let (reason, held_by) = hold.map_or((None, None), |(r, w)| (Some(r), Some(w)));
    if old == state.as_str()
        && row["result_reported_at"] == json!(result)
        && row["canon_status"] == json!(status)
        && row["canon_status_source"] == json!(source)
        && row["failure_reason"] == json!(failure)
        && row["hold_reason"] == json!(reason)
        && row["held_by_work_id"] == json!(held_by)
    {
        return Ok(false);
    }
    let revision = row["revision"].as_i64().ok_or(Error::Invalid("revision"))?;
    tx.execute(
        sql::STATE,
        params![
            id,
            state.as_str(),
            status,
            source,
            reason,
            held_by,
            failure,
            result,
            ctx.now,
            revision
        ],
    )?;
    if old != state.as_str() {
        let scope = (text(&row, "scope_kind")?, text(&row, "scope_ref")?);
        count(tx, scope, &format!("run_state:{old}"), -1)?;
        count(tx, scope, &format!("run_state:{}", state.as_str()), 1)?;
    }
    event(tx, ctx, "work", id, revision + 1, "state")?;
    Ok(true)
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
    state: RunState,
    result_reported: bool,
    failure_reason: Option<&str>,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    allowed_transition(text(&row, "run_state")?, state)?;
    if result_reported && state != RunState::Done {
        return Err(Error::Invalid("only done Works can report completion"));
    }
    if state == RunState::Running && row["draft"] == 1 {
        return Err(Error::Invalid("draft Work cannot start"));
    }
    if state == RunState::Running
        && matches!(row["run_state"].as_str(), Some("idle" | "waiting"))
        && let Some(chain_id) = row["chain_id"].as_str()
        && !ready_works(tx, chain_id)?.iter().any(|work| work == id)
    {
        return Err(Error::Invalid("predecessor barrier is not satisfied"));
    }
    if state == RunState::Held {
        return Err(Error::Invalid("held is derived from predecessor state"));
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
    if changed && let Some(chain_id) = row["chain_id"].as_str() {
        let old = load_chain(tx, chain_id)?;
        if state == RunState::Cancelled {
            leave_cancelled(tx, ctx, id, &old)?;
        } else {
            rederive_holds(tx, ctx, chain_id)?;
            bump(tx, ctx, chain_id, old.graph_revision)?;
        }
    }
    work_result(tx, id, row["chain_id"].as_str())
}
pub(super) fn leave_cancelled(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    old: &StoredChain,
) -> Result<()> {
    let mut pins = running(&[old]);
    pins.remove(&WorkId(id.into()));
    let next = old.chain.delete(&WorkId(id.into()), &pins)?;
    persist(tx, ctx, &[(old, &next)])
}
pub fn set_label(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    label: CanonStatus,
    person: &UserAct,
    expected_graph_revision: Option<i64>,
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
    if matches!(label, CanonStatus::Done | CanonStatus::Cancelled)
        && let Some(chain) = row["chain_id"].as_str()
    {
        cas(
            &one(tx, sql::CHAIN, [chain])?,
            "graph_revision",
            expected_graph_revision.ok_or(Error::Invalid("graph revision required"))?,
        )?;
    }
    let current: RunState = text(&row, "run_state")?
        .parse()
        .map_err(|_| Error::Invalid("run state"))?;
    let state = match label {
        CanonStatus::Done => RunState::Done,
        CanonStatus::Cancelled => RunState::Cancelled,
        _ => current,
    };
    let hold = row["hold_reason"]
        .as_str()
        .zip(row["held_by_work_id"].as_str())
        .filter(|_| state == RunState::Held);
    let changed = set_state(
        tx,
        ctx,
        id,
        state,
        hold,
        row["failure_reason"].as_str(),
        Some((label, "person")),
        label == CanonStatus::Done,
    )?;
    if changed && label == CanonStatus::Done {
        cancel_tasks(tx, ctx, id, &format!("marked done by {}", person.person()))?;
    }
    if changed && let Some(chain_id) = row["chain_id"].as_str() {
        let chain = load_chain(tx, chain_id)?;
        if state == RunState::Cancelled {
            leave_cancelled(tx, ctx, id, &chain)?;
        } else {
            rederive_holds(tx, ctx, chain_id)?;
            bump(tx, ctx, chain_id, chain.graph_revision)?;
        }
    }
    work_result(tx, id, row["chain_id"].as_str())
}
pub(super) fn cancel_tasks(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    reason: &str,
) -> Result<()> {
    let tasks = rows(tx, sql::TASKS, [id])?;
    for task in tasks {
        tx.execute(
            sql::CANCEL_TASK,
            params![
                text(&task, "id")?,
                reason,
                ctx.now,
                task["revision"].as_i64()
            ],
        )?;
        event(
            tx,
            ctx,
            "task",
            text(&task, "id")?,
            task["revision"]
                .as_i64()
                .ok_or(Error::Invalid("revision"))?
                + 1,
            "cancel",
        )?;
    }
    Ok(())
}
/// Readiness is a projection only. It never starts a Work or bypasses drafts.
pub fn ready_works(db: &Connection, chain_id: &str) -> Result<Vec<String>> {
    let chain = load_chain(db, chain_id)?;
    let approvals = rows(db, sql::DECIDED_HOLDS, [chain_id])?;
    let mut ready = Vec::new();
    for member in &chain.members {
        if member["draft"] != 0 || !matches!(member["run_state"].as_str(), Some("idle" | "waiting"))
        {
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
            let approved = approval_covers(&approvals, pred)?;
            satisfied &=
                (pred["run_state"] == "done" && !pred["result_reported_at"].is_null()) || approved;
        }
        if satisfied {
            ready.push(text(member, "id")?.into());
        }
    }
    Ok(ready)
}

fn allowed_transition(from: &str, to: RunState) -> Result<()> {
    use RunState::{
        Blocked, Cancelled, Done, Failed, Held, Idle, InReview, Paused, Running, Stopped, Waiting,
    };
    let allowed: &[&str] = match to {
        Idle => &["idle"],
        Waiting => &[
            "idle",
            "waiting",
            "running",
            "in_review",
            "paused",
            "blocked",
            "stopped",
            "failed",
        ],
        Running => &[
            "idle", "waiting", "running", "failed", "stopped", "paused", "blocked",
        ],
        InReview => &["running", "in_review"],
        Blocked => &["running", "in_review", "blocked"],
        Paused => &["running", "in_review", "blocked", "paused"],
        Failed => &["running", "in_review", "failed"],
        Stopped => &["running", "in_review", "paused", "blocked", "stopped"],
        Done => &["running", "in_review", "done"],
        Cancelled => &[
            "idle",
            "waiting",
            "running",
            "in_review",
            "paused",
            "blocked",
            "failed",
            "stopped",
            "cancelled",
        ],
        Held => &[],
    };
    if allowed.contains(&from) {
        Ok(())
    } else {
        Err(Error::Invalid("runtime transition is not allowed"))
    }
}
