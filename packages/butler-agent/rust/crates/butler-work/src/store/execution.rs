//! Task and part leases. The writer lane owns the enclosing transaction.
mod assigned;
mod delivery;
pub use delivery::*;
mod review;
pub use assigned::*;
pub mod sql;
use super::*;
use crate::work_types::TaskStatus;
pub use review::*;
use rusqlite::params;

pub struct ExecutionScope<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
}
pub fn start_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected: i64,
    scope: &ExecutionScope<'_>,
    attempt_id: &str,
) -> Result<Value> {
    let row = read_task(tx, id)?;
    cas(&row, "revision", expected)?;
    if let Some(owner) = row["assignee_session_id"].as_str()
        && owner != scope.session_id
    {
        return Err(Error::OwnedElsewhere {
            detail: ownership::owned_elsewhere(tx, id, scope.session_id)?.ok_or(Error::NotFound)?,
        });
    }
    if row["status"] == "draft" {
        return Err(Error::Invalid("draft_unresolved"));
    }
    if matches!(row["status"].as_str(), Some("running" | "in_review")) {
        return Err(Error::Running);
    }
    super::task_fields::validate_task_criteria(tx, id)?;
    let lease = match one(tx, sql::LEASE, [id]) {
        Ok(lease) => Some(lease),
        Err(Error::NotFound) => None,
        Err(error) => return Err(error),
    };
    if lease
        .as_ref()
        .is_some_and(|lease| lease["session_id"] != scope.session_id)
    {
        return Err(Error::Invalid("Task lease belongs to another session"));
    }
    tx.execute(sql::TASK_OWNER, params![id, scope.session_id])?;
    transition(tx, ctx, id, expected, TaskStatus::Running, false, None)?;
    let attempt = if let Some(lease) = lease {
        tx.execute(
            sql::CONTINUE_ATTEMPT,
            params![text(&lease, "id")?, scope.session_id, scope.turn_id],
        )?;
        text(&lease, "id")?.to_owned()
    } else {
        insert_attempt(tx, ctx, id, None, scope, attempt_id)?;
        attempt_id.to_owned()
    };
    let checkpoint: Option<String> = tx
        .query_row(ownership::sql::LATEST_CHECKPOINT, [id], |r| r.get(0))
        .optional()?
        .flatten();
    Ok(json!({"task":read_task(tx,id)?,"attempt_id":attempt,"prior_context":checkpoint}))
}
fn insert_attempt(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    part: Option<&str>,
    scope: &ExecutionScope<'_>,
    attempt: &str,
) -> Result<()> {
    let row = read_task(tx, task)?;
    tx.execute(
        sql::INSERT_ATTEMPT,
        params![
            attempt,
            task,
            part,
            row["revision"].as_i64(),
            text(&row, "spec_ref")?,
            scope.session_id,
            scope.turn_id,
            ctx.now
        ],
    )?;
    event(tx, ctx, "attempt", attempt, 0, "start")
}
pub fn start_part(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected: i64,
    scope: &ExecutionScope<'_>,
    attempt: &str,
) -> Result<Value> {
    let part = parts::read_part(tx, id)?;
    cas(&part, "revision", expected)?;
    let task = text(&part, "task_id")?;
    ensure_task_effect(tx, task, scope.session_id)?;
    if !runnable_parts(tx, task)?.iter().any(|p| p["id"] == id) {
        return Err(Error::Invalid("part is not runnable"));
    }
    tx.execute(sql::PART_STATE, params![id, "running", scope.session_id])?;
    refresh_parts_phase(tx, ctx, task)?;
    insert_attempt(tx, ctx, task, Some(id), scope, attempt)?;
    event(tx, ctx, "part", id, expected + 1, "start")?;
    Ok(json!({"part":parts::read_part(tx,id)?,"attempt_id":attempt}))
}
pub fn runnable_parts(db: &Connection, task: &str) -> Result<Vec<Value>> {
    let all = parts::task_parts(db, task)?;
    let edges = parts::part_edges(db, task)?;
    Ok(all
        .iter()
        .filter(|p| {
            p["status"] == "pending"
                && edges.iter().filter(|e| e["succ"] == p["id"]).all(|e| {
                    all.iter()
                        .any(|pred| pred["id"] == e["pred"] && pred["status"] == "completed")
                })
        })
        .cloned()
        .collect())
}
fn refresh_parts_phase(tx: &Transaction<'_>, ctx: &Context, task: &str) -> Result<()> {
    let all = parts::task_parts(tx, task)?;
    let finished = all
        .iter()
        .all(|p| matches!(p["status"].as_str(), Some("completed" | "cancelled")));
    let reviewing = all
        .iter()
        .any(|p| p["status"] == "running" && p["kind"] != "execute");
    let executes_done = !all.is_empty()
        && all
            .iter()
            .filter(|p| p["kind"] == "execute")
            .all(|p| matches!(p["status"].as_str(), Some("completed" | "cancelled")));
    let state = if finished || reviewing || executes_done {
        TaskStatus::InReview
    } else {
        TaskStatus::Running
    };
    let row = read_task(tx, task)?;
    transition(tx, ctx, task, revision(&row)?, state, false, None)?;
    Ok(())
}
pub(super) fn revision(row: &Value) -> Result<i64> {
    row["revision"].as_i64().ok_or(Error::Invalid("revision"))
}
pub(super) fn task_lease(db: &Connection, id: &str, session: &str) -> Result<Value> {
    ownership::ensure_owner_epoch(db, id, session)?;
    let task = read_task(db, id)?;
    if !task["handoff_to_session_id"].is_null() {
        return Err(Error::Invalid("handoff_in_progress"));
    }
    if !matches!(task["status"].as_str(), Some("running" | "in_review")) {
        return Err(Error::Invalid("Task must be started before effects"));
    }
    let lease = one(db, sql::LEASE, [id])?;
    if lease["owner_epoch"] != task["owner_epoch"] {
        return Err(Error::Invalid("stale_owner"));
    }
    if lease["session_id"] != session {
        return Err(Error::Invalid("Task lease belongs to another session"));
    }
    Ok(lease)
}
/// Called immediately before admitting an effect, on the same writer lane as
/// its receipt. A later active Spec revision fences an earlier Task binding.
pub fn ensure_task_effect(db: &Connection, id: &str, session: &str) -> Result<Value> {
    ownership::ensure_owner_epoch(db, id, session)?;
    let lease = match task_lease(db, id, session) {
        Ok(lease) => lease,
        Err(error @ Error::Invalid("stale_owner" | "handoff_in_progress")) => return Err(error),
        Err(Error::Invalid(_)) => one(db, sql::SESSION_PART_LEASE, params![id, session])?,
        Err(error) => return Err(error),
    };
    if lease["owner_epoch"] != read_task(db, id)?["owner_epoch"] {
        return Err(Error::Invalid("stale_owner"));
    }
    super::task_fields::validate_task_criteria(db, id)?;
    Ok(lease)
}
pub struct Submission<'a> {
    pub part_id: Option<&'a str>,
    pub result_id: &'a str,
    pub result_refs: &'a [String],
    pub evidence_refs: &'a [String],
}
pub fn submit_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    scope: &ExecutionScope<'_>,
    submission: &Submission<'_>,
) -> Result<Value> {
    let Submission {
        part_id: part,
        result_id,
        result_refs,
        evidence_refs,
    } = *submission;
    ownership::ensure_owner_epoch(tx, task, scope.session_id)?;
    super::task_fields::validate_task_criteria(tx, task)?;
    let attempt = if let Some(id) = part {
        submit_part(tx, ctx, task, id, scope.session_id)?
    } else {
        task_lease(tx, task, scope.session_id)?
    };
    refresh_parts_phase(tx, ctx, task)?;
    // A new result always invalidates prior reviews, including repeated submits
    // while already in_review (where transition alone would be a no-op).
    parts::touch_task(tx, ctx, task)?;
    let row = read_task(tx, task)?;
    let next = match one(tx, sql::LATEST_RESULT, [task]) {
        Ok(result) => revision(&result)? + 1,
        Err(Error::NotFound) => 1,
        Err(error) => return Err(error),
    };
    let body = put_body(
        tx,
        &json!({"part_id":part,"result_refs":result_refs,"evidence_refs":evidence_refs})
            .to_string(),
    )?;
    tx.execute(
        sql::INSERT_RESULT,
        params![
            result_id,
            next,
            task,
            revision(&row)?,
            text(&attempt, "id")?,
            text(&row, "spec_ref")?,
            body,
            ctx.now
        ],
    )?;
    event(tx, ctx, "result", result_id, next, "submit")?;
    Ok(json!({"result_id":result_id,"result_revision":next,"task":row}))
}
fn submit_part(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    id: &str,
    session: &str,
) -> Result<Value> {
    let row = parts::read_part(tx, id)?;
    if row["task_id"] != task {
        return Err(Error::Invalid("part belongs to another Task"));
    }
    ownership::ensure_owner_epoch(tx, task, session)?;
    let lease = one(tx, sql::PART_LEASE, [id])?;
    if lease["session_id"] != session {
        return Err(Error::Invalid("part lease belongs to another session"));
    }
    tx.execute(
        sql::PART_STATE,
        params![id, "completed", Option::<&str>::None],
    )?;
    tx.execute(
        sql::FINISH_ATTEMPT,
        params![
            text(&lease, "id")?,
            "succeeded",
            ctx.now,
            Option::<&str>::None
        ],
    )?;
    event(tx, ctx, "part", id, revision(&row)? + 1, "submit")?;
    Ok(lease)
}
pub fn fail_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    session: &str,
    reason: &str,
) -> Result<Value> {
    task_lease(tx, id, session)?;
    finish_failed_task(tx, ctx, id, reason)
}
fn finish_failed_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    reason: &str,
) -> Result<Value> {
    tx.execute(
        sql::FINISH_TASK_ATTEMPTS,
        params![id, "failed", ctx.now, Option::<&str>::None],
    )?;
    for part in parts::task_parts(tx, id)? {
        if part["status"] == "running" {
            let part_id = text(&part, "id")?;
            tx.execute(
                sql::PART_STATE,
                params![part_id, "failed", Option::<&str>::None],
            )?;
            event(tx, ctx, "part", part_id, revision(&part)? + 1, "fail")?;
        }
    }
    let row = read_task(tx, id)?;
    transition(
        tx,
        ctx,
        id,
        revision(&row)?,
        TaskStatus::Failed,
        false,
        Some(reason),
    )
}
pub fn fail_part(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    session: &str,
    reason: &str,
) -> Result<Value> {
    let part = parts::read_part(tx, id)?;
    let task = text(&part, "task_id")?;
    ownership::ensure_owner_epoch(tx, task, session)?;
    let lease = one(tx, sql::PART_LEASE, [id])?;
    if lease["session_id"] != session {
        return Err(Error::Invalid("part lease belongs to another session"));
    }
    tx.execute(
        sql::FINISH_ATTEMPT,
        params![text(&lease, "id")?, "failed", ctx.now, Option::<&str>::None],
    )?;
    tx.execute(sql::PART_STATE, params![id, "failed", Option::<&str>::None])?;
    parts::touch_task(tx, ctx, task)?;
    event(tx, ctx, "part", id, revision(&part)? + 1, "fail")?;
    if runnable_parts(tx, task)?.is_empty()
        && !parts::task_parts(tx, task)?
            .iter()
            .any(|p| p["status"] == "running")
    {
        return finish_failed_task(tx, ctx, task, reason);
    }
    refresh_parts_phase(tx, ctx, task)?;
    read_task(tx, task)
}
pub fn block_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    part: Option<&str>,
    session: &str,
    reason: &str,
    checkpoint: Option<&str>,
) -> Result<Value> {
    if let Some(id) = part {
        return block_part(tx, ctx, task, id, session, reason, checkpoint);
    }
    task_lease(tx, task, session)?;
    // Blocking the Task settles every active part, retaining their checkpoints.
    tx.execute(
        sql::FINISH_TASK_ATTEMPTS,
        params![task, "interrupted", ctx.now, checkpoint],
    )?;
    for row in parts::task_parts(tx, task)? {
        if row["status"] == "running" {
            tx.execute(
                sql::PART_STATE,
                params![text(&row, "id")?, "pending", Option::<&str>::None],
            )?;
            event(
                tx,
                ctx,
                "part",
                text(&row, "id")?,
                revision(&row)? + 1,
                "block",
            )?;
        }
    }
    tx.execute(sql::TASK_REASON, params![task, reason])?;
    let row = read_task(tx, task)?;
    transition(
        tx,
        ctx,
        task,
        revision(&row)?,
        TaskStatus::Blocked,
        false,
        None,
    )
}

fn block_part(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &str,
    id: &str,
    session: &str,
    reason: &str,
    checkpoint: Option<&str>,
) -> Result<Value> {
    let row = parts::read_part(tx, id)?;
    if row["task_id"] != task {
        return Err(Error::Invalid("part belongs to another Task"));
    }
    ownership::ensure_owner_epoch(tx, task, session)?;
    let lease = one(tx, sql::PART_LEASE, [id])?;
    if lease["session_id"] != session {
        return Err(Error::Invalid("part lease belongs to another session"));
    }
    tx.execute(
        sql::FINISH_ATTEMPT,
        params![text(&lease, "id")?, "interrupted", ctx.now, checkpoint],
    )?;
    tx.execute(
        sql::PART_STATE,
        params![id, "pending", Option::<&str>::None],
    )?;
    event(tx, ctx, "part", id, revision(&row)? + 1, "block")?;
    tx.execute(sql::TASK_REASON, params![task, reason])?;
    if parts::task_parts(tx, task)?
        .iter()
        .any(|p| p["status"] == "running")
    {
        refresh_parts_phase(tx, ctx, task)?;
        return read_task(tx, task);
    }
    let row = read_task(tx, task)?;
    transition(
        tx,
        ctx,
        task,
        revision(&row)?,
        TaskStatus::Blocked,
        false,
        None,
    )
}
