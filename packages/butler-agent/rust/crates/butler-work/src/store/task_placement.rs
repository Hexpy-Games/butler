use super::*;
use crate::work_types::TaskId;
use rusqlite::params;

/// Insert directly into an existing step. No temporary head/empty chain is
/// published when the first step of a model-authored chain is a stack.
pub fn create_task_in_stack(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &NewTask,
    expected_task_graph_revision: i64,
    anchor: &str,
) -> Result<Value> {
    let work = read_work(tx, &task.work_id)?;
    cas(&work, "task_graph_revision", expected_task_graph_revision)?;
    if matches!(work["run_state"].as_str(), Some("done" | "cancelled")) {
        return Err(Error::Invalid("terminal Work"));
    }
    let anchor = read_task(tx, anchor)?;
    if anchor["work_id"] != task.work_id {
        return Err(Error::CrossChat);
    }
    let chain = load_chain(tx, text(&anchor, "chain_id")?)?;
    let next = chain.chain.place_in_stack(
        TaskId(task.id.clone()),
        &TaskId(text(&anchor, "id")?.into()),
        &running(&[&chain]),
    )?;
    let step = anchor["step_index"]
        .as_i64()
        .ok_or(Error::Invalid("step"))?;
    let stack = next.steps[usize::try_from(step).map_err(|_| Error::Invalid("step"))?]
        .tasks
        .len()
        - 1;
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
            chain.id,
            step,
            stack,
            task.origin.as_str(),
            task.origin_message_id,
            ctx.now,
            ctx.actor.to_string()
        ],
    )?;
    persist(tx, ctx, &[(&chain, &next)])?;
    recompute_work(tx, ctx, &task.work_id)?;
    super::queue::bump_work(tx, ctx, &task.work_id, expected_task_graph_revision)?;
    task_result(tx, &task.id, None)
}
