use super::*;
use crate::{
    work_ids::{IdGenerator, IdKind},
    work_types::*,
};
use rusqlite::params;
use std::collections::BTreeMap;

pub fn undecided_holds(db: &Connection, chain_id: &str) -> Result<Vec<Value>> {
    rows(db, sql::PENDING_HOLDS, [chain_id])
}
fn failed(work: &Value) -> bool {
    matches!(work["run_state"].as_str(), Some("failed" | "stopped"))
}
fn unstarted(work: &Value) -> bool {
    matches!(
        work["run_state"].as_str(),
        Some("idle" | "waiting" | "held")
    )
}
fn coverage(work: &Value) -> Value {
    json!({"id":work["id"],"step":work["step_index"],
        "state":work["run_state"],"generation":work["run_generation"]})
}
pub(super) fn approval_covers(approval: &Value, work: &Value, step: i64) -> bool {
    let covered: Vec<Value> =
        serde_json::from_str(approval["coverage_json"].as_str().unwrap_or("[]"))
            .unwrap_or_default();
    work["step_index"].as_i64() == step.checked_sub(1) && covered.contains(&coverage(work))
}
fn retire_approvals(
    tx: &Transaction<'_>,
    ctx: &Context,
    chain: &str,
    members: &[Value],
) -> Result<Vec<Value>> {
    let mut live = Vec::new();
    for approval in rows(tx, sql::DECIDED_HOLDS, [chain])? {
        let covered: Vec<Value> = serde_json::from_str(text(&approval, "coverage_json")?)?;
        if !covered.is_empty()
            && covered
                .iter()
                .all(|c| members.iter().any(|m| coverage(m) == *c))
        {
            live.push(approval);
        } else {
            resolve(tx, ctx, &approval)?;
        }
    }
    Ok(live)
}
fn resolve(tx: &Transaction<'_>, ctx: &Context, question: &Value) -> Result<()> {
    let id = text(question, "id")?;
    let revision = question["revision"]
        .as_i64()
        .ok_or(Error::Invalid("revision"))?;
    tx.execute(sql::RESOLVE_HOLD, params![id, ctx.now, revision])?;
    event(tx, ctx, "hold_decision", id, revision + 1, "resolve")
}
/// Derive only unstarted members. Approval coverage is a snapshot of failure
/// identity, step and state generation; ordinary label edits cannot revoke it.
pub(super) fn rederive_holds(
    tx: &Transaction<'_>,
    ctx: &Context,
    chain_id: &str,
) -> Result<Vec<Value>> {
    let members = rows(tx, sql::MEMBERS, [chain_id])?;
    let approvals = retire_approvals(tx, ctx, chain_id, &members)?;
    let mut needed = BTreeMap::new();
    for member in members.iter().filter(|m| unstarted(m)) {
        let step = member["step_index"]
            .as_i64()
            .ok_or(Error::Invalid("step"))?;
        let cause = members
            .iter()
            .rev()
            .filter(|pred| {
                failed(pred)
                    && pred["step_index"].as_i64().is_some_and(|i| i < step)
                    && !approvals.iter().any(|a| approval_covers(a, pred, step))
            })
            .max_by_key(|pred| pred["step_index"].as_i64());
        if let Some(cause) = cause {
            let failure_step = cause["step_index"].as_i64().ok_or(Error::Invalid("step"))?;
            let reason = if cause["run_state"] == "stopped" {
                "predecessor_stopped"
            } else {
                "predecessor_failed"
            };
            set_state(
                tx,
                ctx,
                text(member, "id")?,
                RunState::Held,
                Some((reason, text(cause, "id")?)),
                None,
                None,
                false,
            )?;
            // A decided boundary already has its durable card. Remote followers
            // stay held; its approval grants admission only to the immediate step.
            if !approvals
                .iter()
                .any(|a| approval_covers(a, cause, failure_step + 1))
            {
                needed.insert(failure_step + 1, cause);
            }
        } else {
            set_state(
                tx,
                ctx,
                text(member, "id")?,
                RunState::Waiting,
                None,
                None,
                None,
                false,
            )?;
        }
    }
    reconcile_questions(tx, ctx, chain_id, &members, needed)?;
    update_chain_state(tx, chain_id)?;
    undecided_holds(tx, chain_id)
}
fn reconcile_questions(
    tx: &Transaction<'_>,
    ctx: &Context,
    chain_id: &str,
    members: &[Value],
    mut needed: BTreeMap<i64, &Value>,
) -> Result<()> {
    let pending = undecided_holds(tx, chain_id)?;
    for question in &pending {
        let step = question["held_step_index"]
            .as_i64()
            .ok_or(Error::Invalid("step"))?;
        if let Some(cause) = needed.remove(&step) {
            let covered = step_coverage(members, cause);
            if question["failed_work_id"] != cause["id"] || question["coverage_json"] != covered {
                let revision = question["revision"]
                    .as_i64()
                    .ok_or(Error::Invalid("revision"))?;
                tx.execute(
                    sql::REPOINT_HOLD,
                    params![text(question, "id")?, text(cause, "id")?, revision, covered],
                )?;
                event(
                    tx,
                    ctx,
                    "hold_decision",
                    text(question, "id")?,
                    revision + 1,
                    "repoint",
                )?;
            }
        } else {
            resolve(tx, ctx, question)?;
        }
    }
    for (step, cause) in needed {
        let id = IdGenerator::global_next(IdKind::Decision, ctx.now)?;
        tx.execute(
            sql::INSERT_HOLD,
            params![
                id,
                chain_id,
                text(cause, "id")?,
                step,
                id,
                step_coverage(members, cause)
            ],
        )?;
        event(tx, ctx, "hold_decision", &id, 0, "create")?;
    }
    Ok(())
}
/// Mutation receipts include the durable question ids needed to post cards.
pub(super) fn work_result(
    db: &Connection,
    id: &str,
    previous_chain: Option<&str>,
) -> Result<Value> {
    let mut work = read_work(db, id)?;
    let mut questions = match work["chain_id"].as_str() {
        Some(chain) => undecided_holds(db, chain)?,
        None => Vec::new(),
    };
    if let Some(chain) = previous_chain
        && work["chain_id"] != chain
    {
        questions.extend(undecided_holds(db, chain)?);
    }
    work["hold_questions"] = json!(questions);
    Ok(work)
}
pub fn decide_hold(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    expected_graph_revision: i64,
    decision: Decision,
) -> Result<Value> {
    let row = one(tx, sql::HOLD, [id])?;
    cas(&row, "revision", expected_revision)?;
    if !row["decision"].is_null() || !row["resolved_at"].is_null() {
        return Err(Error::Conflict { current: row });
    }
    let chain_id = text(&row, "chain_id")?;
    let chain = load_chain(tx, chain_id)?;
    cas(
        &one(tx, sql::CHAIN, [chain_id])?,
        "graph_revision",
        expected_graph_revision,
    )?;
    tx.execute(
        sql::DECIDE,
        params![id, decision.as_str(), ctx.now, expected_revision],
    )?;
    if decision == Decision::Delete {
        let mut next = chain.chain.clone();
        for member in &chain.members {
            if member["run_state"] != "held"
                || member["step_index"].as_i64() < row["held_step_index"].as_i64()
            {
                continue;
            }
            let work_id = text(member, "id")?;
            set_state(
                tx,
                ctx,
                work_id,
                RunState::Cancelled,
                None,
                None,
                None,
                false,
            )?;
            cancel_tasks(tx, ctx, work_id, "held steps deleted")?;
            next = next.delete(&WorkId(work_id.into()), &running(&[&chain]))?;
        }
        persist(tx, ctx, &[(&chain, &next)])?;
    } else {
        rederive_holds(tx, ctx, chain_id)?;
        bump(tx, ctx, chain_id, expected_graph_revision)?;
    }
    event(
        tx,
        ctx,
        "hold_decision",
        id,
        expected_revision + 1,
        "decide",
    )?;
    let mut result = one(tx, sql::HOLD, [id])?;
    result["hold_questions"] = json!(undecided_holds(tx, chain_id)?);
    Ok(result)
}

fn step_coverage(members: &[Value], cause: &Value) -> String {
    let covered: Vec<_> = members
        .iter()
        .filter(|m| failed(m) && m["step_index"] == cause["step_index"])
        .map(coverage)
        .collect();
    json!(covered).to_string()
}
