//! A change-driven snapshot of ready reservations; assignment rechecks readiness.
use super::*;
use crate::work_queries::Query;
use rusqlite::params;

#[derive(Debug, Clone)]
pub struct ReadyStart {
    pub task_id: String,
    pub work_id: String,
    pub coordinator_session: String,
    pub reserved_session_id: String,
}
#[derive(Debug, Clone)]
pub struct ReadyBatch {
    pub op: String,
    pub revision: i64,
    pub starts: Vec<ReadyStart>,
}
/// Coalesce changes to one Work. The revision prevents an old snapshot from
/// acknowledging a completion or edit that landed during assignment.
pub(super) fn changed(tx: &Transaction<'_>, ctx: &Context, kind: &str, id: &str) -> Result<()> {
    let work = match kind {
        "task" => read_task(tx, id)?["work_id"].as_str().map(str::to_owned),
        "task_graph" | "work" => Some(id.to_owned()),
        _ => None,
    };
    if let Some(work) = work
        && !read_work(tx, &work)?["started_at"].is_null()
    {
        tx.execute(
            ownership_sql::READY_CHANGED,
            params![format!("ready_start:{work}"), work, ctx.now],
        )?;
    }
    Ok(())
}
pub fn ready_starts(db: &Connection) -> Result<Vec<ReadyBatch>> {
    let mut batches = Vec::new();
    for work in rows(db, Query::ReadyWorks.sql(), [])? {
        let mut batch = ReadyBatch {
            op: text(&work, "ready_op")?.into(),
            revision: work["ready_revision"]
                .as_i64()
                .ok_or(Error::Invalid("intent revision"))?,
            starts: Vec::new(),
        };
        if let Some(coordinator) = work["home_session_id"].as_str()
            && !work["started_at"].is_null()
            && matches!(
                work["run_state"].as_str(),
                Some("idle" | "running" | "in_review" | "blocked" | "failed")
            )
        {
            collect_starts(db, &work, coordinator, &mut batch.starts)?;
        }
        batches.push(batch);
    }
    Ok(batches)
}
fn collect_starts(
    db: &Connection,
    work: &Value,
    coordinator: &str,
    starts: &mut Vec<ReadyStart>,
) -> Result<()> {
    for chain in rows(
        db,
        Query::TaskChains.sql(),
        params![text(work, "id")?, "active"],
    )? {
        for id in ready_tasks(db, text(&chain, "id")?)? {
            let task = read_task(db, &id)?;
            if let Some(reserved) = task["reserved_session_id"].as_str()
                && task["assignee_session_id"].is_null()
                && matches!(task["status"].as_str(), Some("pending" | "waiting"))
            {
                starts.push(ReadyStart {
                    task_id: id,
                    work_id: text(work, "id")?.into(),
                    coordinator_session: coordinator.into(),
                    reserved_session_id: reserved.into(),
                });
            }
        }
    }
    Ok(())
}
pub fn acknowledge_ready(tx: &Transaction<'_>, op: &str, revision: i64) -> Result<()> {
    tx.execute(super::sql::APPLY_INTENT, params![op, revision])?;
    Ok(())
}

/// Startup-only inventory supports installations predating ready-start intents.
pub fn recover_ready(tx: &Transaction<'_>, ctx: &Context) -> Result<()> {
    for work in rows(tx, ownership_sql::STARTUP_READY, [])? {
        changed(tx, ctx, "work", text(&work, "id")?)?;
    }
    Ok(())
}
