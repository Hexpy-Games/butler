//! Assignment preserves the owning Task and grants only the selected lease.
use super::*;

pub fn assign_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    expected: i64,
    child: &ExecutionScope<'_>,
    attempt: &str,
) -> Result<Value> {
    let row = read_task(tx, task)?;
    if !matches!(row["status"].as_str(), Some("pending" | "waiting")) {
        return Err(Error::Invalid("assigned Task must be ready"));
    }
    start_task(tx, ctx, task, expected, child, attempt)
}

pub fn assign_part(
    tx: &Transaction<'_>,
    ctx: &Context,
    part: &str,
    expected: i64,
    parent_session: &str,
    child: &ExecutionScope<'_>,
    attempt: &str,
) -> Result<Value> {
    let row = parts::read_part(tx, part)?;
    cas(&row, "revision", expected)?;
    let task = text(&row, "task_id")?;
    // A child executing an assigned part may itself delegate a finer part.
    ensure_task_effect(tx, task, parent_session)?;
    if !runnable_parts(tx, task)?.iter().any(|p| p["id"] == part) {
        return Err(Error::Invalid("part is not runnable"));
    }
    tx.execute(sql::PART_STATE, params![part, "running", child.session_id])?;
    refresh_parts_phase(tx, ctx, task)?;
    insert_attempt(tx, ctx, task, Some(part), child, attempt)?;
    event(tx, ctx, "part", part, expected + 1, "assign")?;
    Ok(json!({"part":parts::read_part(tx,part)?,"attempt_id":attempt}))
}

pub fn report_task(tx: &Transaction<'_>, ctx: &Context, task: &str) -> Result<Value> {
    let row = read_task(tx, task)?;
    if row["status"] != "completed" {
        return Err(Error::Invalid("only completed Tasks can report"));
    }
    transition(
        tx,
        ctx,
        task,
        revision(&row)?,
        TaskStatus::Completed,
        true,
        None,
    )
}
