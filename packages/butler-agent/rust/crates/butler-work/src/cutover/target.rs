use super::sql;
use super::{
    import::{chains, stable_id},
    shape::Layout,
    source::{Source, text},
};
use crate::store::{Context, Result, Transaction};
use rusqlite::params;
use serde_json::{Value, json};

pub(super) fn tasks(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    work: &str,
    spec: &Value,
    layout: Layout,
) -> Result<()> {
    // Re-import retains stable IDs and historical rows. Removed actions become
    // cancelled rather than erasing evidence; immutable Spec history stays put.
    tx.execute(sql::CLEAR_EDGES, [work])?;
    tx.execute(sql::RETIRE_TASKS, [work])?;
    if let Some(layout) = layout.chains {
        for (chain_id, chain) in chains(&layout, work) {
            migrate_chain(tx, ctx, source, work, spec, &chain_id, chain)?;
        }
    } else {
        parts(tx, ctx, source, work, spec, &layout.edges)?;
    }
    tx.execute(
        sql::TASK_EVENT,
        params![json!({"work_id":work,"scope":"tasks"}).to_string(), ctx.now],
    )?;
    Ok(())
}
fn migrate_chain(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    work: &str,
    spec: &Value,
    chain_id: &str,
    chain: &crate::work_chain::Chain,
) -> Result<()> {
    ensure_chain(tx, ctx, work, chain_id)?;
    let live = remove_cancelled(tx, ctx, source, work, spec, chain_id, chain)?;
    for step in &live.steps {
        for (position, action_id) in step.tasks.iter().enumerate() {
            let action = source
                .actions
                .iter()
                .find(|a| a.action_key == action_id.0)
                .ok_or(crate::store::Error::Invalid("missing action"))?;
            task(
                tx,
                ctx,
                source,
                Task {
                    id: &stable_id("tk", work, &action.action_key),
                    source_key: Some(&action.action_key),
                    work,
                    spec,
                    title: &action.description,
                    status: status(source, &action.action_key, step.index),
                    chain: chain_id,
                    step: step.index,
                    position,
                },
            )?;
        }
    }
    for (pred, succ) in live.edges()? {
        tx.execute(
            sql::INSERT_EDGE,
            params![
                work,
                chain_id,
                stable_id("tk", work, &pred.0),
                stable_id("tk", work, &succ.0)
            ],
        )?;
    }
    let done = live
        .steps
        .iter()
        .flat_map(|s| &s.tasks)
        .all(|id| status(source, &id.0, 0) == "completed");
    tx.execute(
        sql::CHAIN_STATE,
        params![chain_id, if done { "done" } else { "active" }],
    )?;
    Ok(())
}
fn remove_cancelled(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    work: &str,
    spec: &Value,
    chain_id: &str,
    chain: &crate::work_chain::Chain,
) -> Result<crate::work_chain::Chain> {
    let mut live = chain.clone();
    for step in &chain.steps {
        for action_id in &step.tasks {
            if status(source, &action_id.0, step.index) == "cancelled" {
                let action = source
                    .actions
                    .iter()
                    .find(|a| a.action_key == action_id.0)
                    .ok_or(crate::store::Error::Invalid("missing action"))?;
                task(
                    tx,
                    ctx,
                    source,
                    Task {
                        id: &stable_id("tk", work, &action.action_key),
                        source_key: Some(&action.action_key),
                        work,
                        spec,
                        title: &action.description,
                        status: "cancelled",
                        chain: chain_id,
                        step: 0,
                        position: 0,
                    },
                )?;
                live = live.delete(action_id, &std::collections::BTreeSet::new())?;
            }
        }
    }
    Ok(live)
}
fn ensure_chain(tx: &Transaction<'_>, ctx: &Context, work: &str, id: &str) -> Result<()> {
    tx.execute(sql::ENSURE_CHAIN, params![id, work, ctx.now])?;
    Ok(())
}
fn status(source: &Source, key: &str, step: usize) -> &'static str {
    let progress = source
        .progress
        .as_array()
        .and_then(|items| items.iter().find(|v| v["actionKey"] == key))
        .and_then(|v| v["status"].as_str());
    match progress {
        Some("done") => "completed",
        Some("skipped") => "cancelled",
        Some("blocked") => "blocked",
        _ if source.work["status"] == "abandoned" => "cancelled",
        _ if step == 0 => "pending",
        _ => "waiting",
    }
}
struct Task<'a> {
    id: &'a str,
    source_key: Option<&'a str>,
    work: &'a str,
    spec: &'a Value,
    title: &'a str,
    status: &'a str,
    chain: &'a str,
    step: usize,
    position: usize,
}
fn task(tx: &Transaction<'_>, ctx: &Context, source: &Source, task: Task<'_>) -> Result<()> {
    let spec_ref = task.spec.to_string();
    let actor = ctx.actor.to_string();
    let member = task.status != "cancelled";
    let chain = member.then_some(task.chain);
    let step = member.then_some(task.step as i64);
    let position = member.then_some(task.position as i64);
    let historical = task.status == "completed";
    let reported = historical.then_some(ctx.now);
    let values = params![
        task.id,
        task.work,
        spec_ref,
        task.title,
        task.status,
        chain,
        step,
        position,
        historical,
        reported,
        ctx.now,
        actor
    ];
    let exists: bool = tx.query_row(sql::TASK_EXISTS, [task.id], |r| r.get(0))?;
    if exists {
        tx.execute(sql::UPDATE_TASK, &values[..11])?;
    } else {
        tx.execute(sql::INSERT_TASK, values)?;
    }
    let assignee = if source.delegated {
        Some(text(&source.work, "session_id")?)
    } else {
        None
    };
    tx.execute(sql::TASK_ASSIGNMENT, params![task.id, assignee])?;
    if let Some(key) = task.source_key {
        let revision = tx.query_row(sql::TASK_REVISION, [task.id], |r| r.get(0))?;
        action_alias(tx, source, key, task.id, revision)?;
    }
    Ok(())
}
fn action_alias(
    tx: &Transaction<'_>,
    source: &Source,
    key: &str,
    target: &str,
    revision: i64,
) -> Result<()> {
    let work = text(&source.work, "work_id")?;
    let identity = serde_json::to_string(&(work, key))?;
    super::import::remember_alias(
        tx,
        "action",
        &identity,
        target,
        &source.hash,
        revision,
        work,
    )
}
fn parts(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    work: &str,
    spec: &Value,
    edges: &[(crate::work_types::TaskId, crate::work_types::TaskId)],
) -> Result<()> {
    let id = stable_id("aggregate", work, "");
    let chain_id = stable_id("ch", work, "aggregate");
    ensure_chain(tx, ctx, work, &chain_id)?;
    let aggregate_status = if source
        .actions
        .iter()
        .all(|a| status(source, &a.action_key, 0) == "completed")
    {
        "completed"
    } else {
        status(source, "", 0)
    };
    task(
        tx,
        ctx,
        source,
        Task {
            id: &id,
            source_key: None,
            work,
            spec,
            title: text(&source.work, "objective")?,
            status: aggregate_status,
            chain: &chain_id,
            step: 0,
            position: 0,
        },
    )?;
    tx.execute(sql::CLEAR_PART_EDGES, [&id])?;
    tx.execute(sql::RETIRE_PARTS, [&id])?;
    for (i, action) in source.actions.iter().enumerate() {
        let status = match status(source, &action.action_key, 0) {
            "completed" => "completed",
            "cancelled" => "cancelled",
            _ => "pending",
        };
        tx.execute(
            sql::UPSERT_PART,
            params![
                stable_id("pt", work, &action.action_key),
                id,
                action.description,
                status,
                format!("{i:020}")
            ],
        )?;
        action_alias(
            tx,
            source,
            &action.action_key,
            &stable_id("pt", work, &action.action_key),
            0,
        )?;
    }
    for (pred, succ) in edges {
        tx.execute(
            sql::INSERT_PART_EDGE,
            params![
                id,
                stable_id("pt", work, &pred.0),
                stable_id("pt", work, &succ.0)
            ],
        )?;
    }
    Ok(())
}
