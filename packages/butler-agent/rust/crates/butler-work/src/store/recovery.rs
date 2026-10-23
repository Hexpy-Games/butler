use super::*;
use crate::work_types::TaskStatus;
use rusqlite::params;
use std::collections::BTreeSet;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviousShutdown {
    Clean,
    Crash,
    FirstBoot,
}
/// Indexed keyset walk at startup/shutdown, never on a request or polling path.
pub fn next_recovery_session(db: &Connection, after: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(sql::RECOVERY_SESSION, [after], |r| r.get(0))
        .optional()?)
}

/// Called only after Turn futures and their effects have drained. Preserve the
/// last durable checkpoint; shutdown must not invent a successful outcome.
pub fn checkpoint_session(tx: &Transaction<'_>, ctx: &Context, session: &str) -> Result<()> {
    if tx.execute(sql::CHECKPOINT_SESSION, params![session, ctx.now])? > 0 {
        event(tx, ctx, "session", session, 0, "checkpoint_shutdown")?;
    }
    Ok(())
}
pub fn begin_boot(tx: &Transaction<'_>, ctx: &Context, boot_id: &str) -> Result<PreviousShutdown> {
    let previous = match one(tx, sql::MARKER, []) {
        Ok(row) if row["clean_shutdown_at"].is_null() => PreviousShutdown::Crash,
        Ok(_) => PreviousShutdown::Clean,
        Err(Error::NotFound) => PreviousShutdown::FirstBoot,
        Err(e) => return Err(e),
    };
    tx.execute(sql::BOOT, params![boot_id, ctx.now])?;
    event(tx, ctx, "runtime_marker", boot_id, 0, "begin_boot")?;
    Ok(previous)
}
pub fn mark_clean_shutdown(tx: &Transaction<'_>, ctx: &Context, boot_id: &str) -> Result<()> {
    let row = one(tx, sql::MARKER, [])?;
    if row["boot_id"] != boot_id {
        return Err(Error::Conflict { current: row });
    }
    tx.execute(sql::CLEAN, params![ctx.now, boot_id])?;
    event(tx, ctx, "runtime_marker", boot_id, 0, "clean_shutdown")
}
/// Called once per known session on startup, never polled. Reads use the
/// session/status index, including interrupted attempts after a clean stop.
pub fn recover_session(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    previous: PreviousShutdown,
) -> Result<Vec<Value>> {
    let attempts = rows(tx, sql::RECOVER_ATTEMPTS, [session])?;
    let mut tasks = BTreeSet::new();
    for attempt in &attempts {
        let id = text(attempt, "id")?;
        tx.execute(
            sql::INTERRUPT,
            params![id, ctx.now, attempt["revision"].as_i64()],
        )?;
        tasks.insert(text(attempt, "task_id")?.to_owned());
        if let Some(part) = attempt["part_id"].as_str() {
            let status = if previous == PreviousShutdown::Clean {
                "pending"
            } else {
                "failed"
            };
            tx.execute(sql::RECOVER_PART, params![part, status])?;
        }
        event(
            tx,
            ctx,
            "attempt",
            id,
            attempt["revision"]
                .as_i64()
                .ok_or(Error::Invalid("revision"))?
                + 1,
            "interrupted",
        )?;
    }
    for id in &tasks {
        let task = read_task(tx, id)?;
        if !task["handoff_to_session_id"].is_null() {
            let checkpoint: Option<String> = tx
                .query_row(ownership::sql::LATEST_CHECKPOINT, [id], |r| r.get(0))
                .optional()?
                .flatten();
            let checkpoint = match checkpoint {
                Some(checkpoint) => checkpoint,
                None => put_body(
                    tx,
                    &json!({"interrupted_attempts":attempts,"task_id":id}).to_string(),
                )?,
            };
            ownership::complete_handoff(tx, ctx, id, &checkpoint)?;
            continue;
        }
        if !matches!(task["status"].as_str(), Some("running" | "in_review")) {
            continue;
        }
        let revision = task["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?;
        if previous == PreviousShutdown::Clean {
            transition(tx, ctx, id, revision, TaskStatus::Pending, false, None)?;
        } else {
            transition(
                tx,
                ctx,
                id,
                revision,
                TaskStatus::Failed,
                false,
                Some("interrupted_by_crash"),
            )?;
        }
    }
    Ok(attempts)
}
/// Use this wrapper when a domain mutation needs an App DB projection. Replay
/// returns the original receipt before invoking the mutation closure.
pub fn with_intent(
    tx: &Transaction<'_>,
    ctx: &Context,
    op_id: &str,
    kind: &str,
    payload: &Value,
    change: impl FnOnce(&Transaction<'_>) -> Result<()>,
) -> Result<Value> {
    match one(tx, sql::INTENT, [op_id]) {
        Ok(row) => return Ok(row),
        Err(Error::NotFound) => {}
        Err(e) => return Err(e),
    }
    change(tx)?;
    record_intent(tx, ctx, op_id, kind, payload)
}
pub fn record_intent(
    tx: &Transaction<'_>,
    ctx: &Context,
    op_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<Value> {
    let inserted = tx.execute(
        sql::INSERT_INTENT,
        params![op_id, kind, payload.to_string(), ctx.now],
    )?;
    if inserted > 0 {
        event(tx, ctx, "intent", op_id, 0, "record")?;
    }
    one(tx, sql::INTENT, [op_id])
}
pub fn pending_intents(db: &Connection, after: &str, limit: usize) -> Result<Vec<Value>> {
    rows(db, sql::PENDING_INTENTS, params![after, limit])
}
pub fn mark_intent_applied(
    tx: &Transaction<'_>,
    ctx: &Context,
    op_id: &str,
    expected_revision: i64,
) -> Result<Value> {
    let row = one(tx, sql::INTENT, [op_id])?;
    cas(&row, "revision", expected_revision)?;
    if row["state"] != "applied" {
        tx.execute(sql::APPLY_INTENT, params![op_id, expected_revision])?;
        event(tx, ctx, "intent", op_id, expected_revision + 1, "applied")?;
    }
    one(tx, sql::INTENT, [op_id])
}
