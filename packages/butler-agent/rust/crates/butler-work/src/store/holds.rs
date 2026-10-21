use super::*;
use crate::{
    work_ids::{IdGenerator, IdKind},
    work_types::*,
};
use rusqlite::params;
pub fn undecided_holds(db: &Connection, chain_id: &str) -> Result<Vec<Value>> {
    rows(db, sql::PENDING_HOLDS, [chain_id])
}
pub(super) fn hold_followers(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    question: &str,
) -> Result<()> {
    let row = read_work(tx, id)?;
    let chain_id = text(&row, "chain_id")?;
    let step = row["step_index"].as_i64().ok_or(Error::Invalid("step"))?;
    let members = rows(tx, sql::MEMBERS, [chain_id])?;
    let reason = if row["run_state"] == "stopped" {
        "predecessor_stopped"
    } else {
        "predecessor_failed"
    };
    let pending = undecided_holds(tx, chain_id)?;
    let held_by = pending
        .iter()
        .find(|p| p["held_step_index"] == step + 1)
        .and_then(|p| p["failed_work_id"].as_str())
        .unwrap_or(id);
    for member in members
        .iter()
        .filter(|m| m["step_index"].as_i64().is_some_and(|i| i > step))
    {
        if matches!(member["run_state"].as_str(), Some("done" | "cancelled")) {
            continue;
        }
        set_state(
            tx,
            ctx,
            text(member, "id")?,
            RunState::Held,
            Some((reason, held_by)),
            None,
            None,
            false,
        )?;
    }
    if !pending.iter().any(|p| p["held_step_index"] == step + 1) {
        let decision_id = IdGenerator::global_next(IdKind::Decision, ctx.now)?;
        tx.execute(
            sql::INSERT_HOLD,
            params![decision_id, chain_id, id, step + 1, question],
        )?;
        event(tx, ctx, "hold_decision", &decision_id, 0, "create")?;
    }
    update_chain_state(tx, chain_id)
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
    if !row["decision"].is_null() {
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
    let failed = text(&row, "failed_work_id")?;
    let failure = read_work(tx, failed)?;
    let next_step = failure["step_index"].as_i64().map(|i| i + 1);
    let mut next = chain.chain.clone();
    for member in &chain.members {
        if member["run_state"] != "held" || member["held_by_work_id"] != failed {
            continue;
        }
        let work_id = text(member, "id")?;
        match decision {
            Decision::RunAnyway if member["step_index"].as_i64() == next_step => {
                set_state(tx, ctx, work_id, RunState::Waiting, None, None, None, false)?;
            }
            Decision::Delete => {
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
            Decision::RunAnyway => {}
        }
    }
    if decision == Decision::Delete {
        persist(tx, ctx, &[(&chain, &next)])?;
    } else {
        bump(tx, ctx, chain_id, expected_graph_revision)?;
        update_chain_state(tx, chain_id)?;
    }
    event(
        tx,
        ctx,
        "hold_decision",
        id,
        expected_revision + 1,
        "decide",
    )?;
    one(tx, sql::HOLD, [id])
}
/// A released step finishing opens its immediate follower; remote later steps
/// remain held until their own complete, reported predecessor barrier clears.
pub(super) fn release_satisfied_holds(
    tx: &Transaction<'_>,
    ctx: &Context,
    chain_id: &str,
) -> Result<()> {
    let chain = load_chain(tx, chain_id)?;
    for member in &chain.members {
        if member["run_state"] != "held" {
            continue;
        }
        let step = member["step_index"]
            .as_u64()
            .ok_or(Error::Invalid("step"))?;
        let predecessors: Vec<_> = chain
            .members
            .iter()
            .filter(|p| p["step_index"].as_u64() == step.checked_sub(1))
            .collect();
        if predecessors
            .iter()
            .all(|p| p["run_state"] == "done" && !p["result_reported_at"].is_null())
        {
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
    Ok(())
}
