use super::*;
use crate::work_types::RunState;
use rusqlite::params;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviousShutdown {
    Clean,
    Crash,
    FirstBoot,
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
    questions: &BTreeMap<String, String>,
) -> Result<Vec<String>> {
    let attempts = rows(tx, sql::RECOVER_ATTEMPTS, [session])?;
    let mut works = BTreeSet::new();
    for attempt in &attempts {
        let id = text(attempt, "id")?;
        tx.execute(
            sql::INTERRUPT,
            params![id, ctx.now, attempt["revision"].as_i64()],
        )?;
        let work = text(attempt, "work_id")?;
        works.insert(work.to_owned());
        event(
            tx,
            ctx,
            "attempt",
            id,
            attempt["revision"]
                .as_i64()
                .ok_or(Error::Invalid("attempt revision"))?
                + 1,
            "interrupted",
        )?;
        if previous == PreviousShutdown::Clean {
            let task = one(tx, sql::TASK, [text(attempt, "task_id")?])?;
            if !matches!(task["status"].as_str(), Some("completed" | "cancelled")) {
                let revision = task["revision"]
                    .as_i64()
                    .ok_or(Error::Invalid("task revision"))?;
                tx.execute(
                    sql::RECOVER_TASK,
                    params![text(&task, "id")?, ctx.now, revision],
                )?;
                event(
                    tx,
                    ctx,
                    "task",
                    text(&task, "id")?,
                    revision + 1,
                    "recover_pending",
                )?;
            }
        }
    }
    for id in &works {
        let work = read_work(tx, id)?;
        if matches!(work["run_state"].as_str(), Some("done" | "cancelled")) {
            continue;
        }
        let revision = work["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?;
        if previous == PreviousShutdown::Clean {
            transition(tx, ctx, id, revision, RunState::Waiting, false, None, None)?;
        } else {
            transition(
                tx,
                ctx,
                id,
                revision,
                RunState::Failed,
                false,
                Some("interrupted_by_crash"),
                questions.get(id).map(String::as_str),
            )?;
        }
    }
    Ok(works.into_iter().collect())
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
