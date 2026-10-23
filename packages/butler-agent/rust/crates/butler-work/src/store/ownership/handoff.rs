//! Ownership changes serialize with completion on the writer lane.
use super::*;
use crate::work_types::TaskStatus;

pub fn take_here(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    to: &str,
    expected: i64,
) -> Result<Value> {
    let row = read_task(tx, task)?;
    cas(&row, "revision", expected)?;
    if matches!(row["status"].as_str(), Some("completed" | "cancelled")) {
        return Err(Error::Conflict { current: row });
    }
    if row["assignee_session_id"] == to {
        return Ok(row);
    }
    if matches!(row["status"].as_str(), Some("running" | "in_review")) {
        return begin_handoff(tx, ctx, &row, to, expected);
    }
    if tx.execute(sql::TAKE_RESERVED, params![task, to, ctx.now, expected])? != 1 {
        return Err(Error::Conflict {
            current: read_task(tx, task)?,
        });
    }
    continue_here(tx, ctx, task, to, false)?;
    event(tx, ctx, "task", task, expected + 1, "take_here")?;
    read_task(tx, task)
}
fn begin_handoff(
    tx: &Transaction<'_>,
    ctx: &Context,
    row: &Value,
    to: &str,
    expected: i64,
) -> Result<Value> {
    let task = text(row, "id")?;
    if tx.execute(sql::BEGIN_HANDOFF, params![task, to, ctx.now, expected])? != 1 {
        return Err(Error::Conflict {
            current: read_task(tx, task)?,
        });
    }
    let old = text(row, "assignee_session_id")?;
    let hold = hold_session(tx, ctx, old, "stop", to)?;
    tx.execute(sql::HOLD_REASON, [text(&hold, "hold_id")?])?;
    let title = text(row, "title")?;
    let instruction = format!(
        "Task {task} ‘{title}’ is moving to another conversation at the user's request. Let the current tool call finish or settle, start no new effects, and end this turn with one line on where you stopped. The runtime saves your progress as the checkpoint, and the new owner continues from it. This is not a failure: do not call task.fail or task.block, and do not report an error."
    );
    admit_instruction(
        tx,
        ctx,
        &SessionInstruction {
            target: old,
            sender: json!({"user":{"principal_id":to}}),
            mode: "steer",
            body: json!({"text":instruction}),
            idempotency_key: &format!("handoff:{task}:{}", row["owner_epoch"]),
            expected_control_epoch: control_epoch(tx, old)?,
            anchor_task: task,
        },
    )?;
    record_intent(
        tx,
        ctx,
        &format!("handoff_stop:{task}:{}", row["owner_epoch"]),
        "handoff_stop",
        &json!({"task_id":task,"session_id":old,"owner_epoch":row["owner_epoch"]}),
    )?;
    event(tx, ctx, "task", task, expected + 1, "begin_handoff")?;
    read_task(tx, task)
}
/// Acknowledgement means the old turn and its effects have settled. Startup
/// invokes the same operation after interrupting its attempts.
pub fn complete_handoff(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    checkpoint: &str,
) -> Result<Value> {
    let row = read_task(tx, task)?;
    let Some(to) = row["handoff_to_session_id"].as_str() else {
        return Ok(row);
    };
    let old = text(&row, "assignee_session_id")?;
    tx.execute(
        execution_sql::FINISH_TASK_ATTEMPTS,
        params![task, "interrupted", ctx.now, checkpoint],
    )?;
    transition(
        tx,
        ctx,
        task,
        execution::revision(&row)?,
        TaskStatus::Stopped,
        false,
        None,
    )?;
    let stopped = read_task(tx, task)?;
    if tx.execute(
        sql::MOVE_OWNER,
        params![
            task,
            to,
            ctx.now,
            execution::revision(&stopped)?,
            row["owner_epoch"].as_i64()
        ],
    )? != 1
    {
        return Err(Error::Conflict {
            current: read_task(tx, task)?,
        });
    }
    let moved = read_task(tx, task)?;
    transition(
        tx,
        ctx,
        task,
        execution::revision(&moved)?,
        TaskStatus::Pending,
        false,
        None,
    )?;
    for instruction in pending_instructions(tx, old, true)? {
        if instruction["idempotency_key"].as_str()
            == Some(&format!("handoff:{task}:{}", row["owner_epoch"]))
        {
            let id = text(&instruction, "id")?;
            deliver_instruction(tx, ctx, id, text(&instruction, "status")?)?;
            apply_instruction(tx, ctx, id)?;
        }
    }
    for hold in active_session_holds(tx, old)? {
        if hold["reason"] == "handoff" && hold["owner"] == to {
            release_session_hold(tx, ctx, text(&hold, "id")?, control_epoch(tx, old)?)?;
        }
    }
    continue_here(tx, ctx, task, to, true)?;
    event(
        tx,
        ctx,
        "task",
        task,
        execution::revision(&moved)?,
        "handoff",
    )?;
    read_task(tx, task)
}
fn continue_here(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    to: &str,
    moved: bool,
) -> Result<()> {
    let row = read_task(tx, task)?;
    let work = read_work(tx, text(&row, "work_id")?)?;
    tiers::admit(
        tx,
        ctx,
        to,
        text(&work, "id")?,
        u8::try_from(work["tier"].as_u64().unwrap_or(1).max(1))
            .map_err(|_| Error::Invalid("Work tier"))?,
        "task_session",
    )?;
    tiers::bind_started_task(tx, to, task)?;
    let title = text(&row, "title")?;
    let mut instruction =
        format!("Continue Task {task} ‘{title}’ in this conversation. Call task.start on it.");
    if moved {
        instruction.push_str(" It resumes from the checkpoint its previous session saved; do not redo finished steps.");
    }
    let receipt = admit_instruction(
        tx,
        ctx,
        &SessionInstruction {
            target: to,
            sender: ctx.actor.clone(),
            mode: "queue",
            body: json!({"text":instruction}),
            idempotency_key: &format!("continue:{task}:{}", row["owner_epoch"]),
            expected_control_epoch: control_epoch(tx, to)?,
            anchor_task: task,
        },
    )?;
    record_intent(
        tx,
        ctx,
        &format!("task_continue:{task}:{}", row["owner_epoch"]),
        "task_continue",
        &json!({"session_id":to,"task_id":task,"instruction_id":receipt["instruction_id"],"text":instruction}),
    )?;
    Ok(())
}
