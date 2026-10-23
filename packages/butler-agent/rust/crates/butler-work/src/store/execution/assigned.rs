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
    if row["reserved_session_id"] != child.session_id || !row["assignee_session_id"].is_null() {
        return Err(Error::Conflict { current: row });
    }
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
    tx.execute(sql::REGISTER_REPORT, params![attempt, task, parent_session])?;
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

/// A returning result continues the session's live part without taking a new lease.
pub fn continue_part_turn(
    tx: &Transaction<'_>,
    ctx: &Context,
    part: &str,
    session: &str,
    turn: &str,
) -> Result<bool> {
    let row = parts::read_part(tx, part)?;
    if row["status"] != "running" {
        return Ok(false);
    }
    let lease = one(tx, sql::PART_LEASE, [part])?;
    if lease["session_id"] != session {
        return Err(Error::Invalid("part lease belongs to another session"));
    }
    let task = read_task(tx, text(&row, "task_id")?)?;
    if task["status"] == "in_review" {
        return Err(Error::Invalid(
            "The Task is in review. Finish its review before continuing execution.",
        ));
    }
    super::super::task_fields::validate_task_criteria(tx, text(&row, "task_id")?)?;
    tx.execute(
        sql::CONTINUE_ATTEMPT,
        params![text(&lease, "id")?, session, turn],
    )?;
    event(
        tx,
        ctx,
        "attempt",
        text(&lease, "id")?,
        revision(&lease)? + 1,
        "continue",
    )?;
    Ok(true)
}
