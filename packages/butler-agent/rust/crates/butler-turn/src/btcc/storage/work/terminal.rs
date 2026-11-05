//! Close execution-owned Work and its remaining actions with a delegation.
use super::{StorageError, StorageResult, common, mutation, read, relation};
use crate::btcc::{ActionStatus, WorkStage};
use rusqlite::Connection;

pub(in crate::btcc::storage) fn close_session(
    db: &Connection,
    session: &str,
    now: &str,
) -> StorageResult<()> {
    let works = db.prepare_cached(
        "SELECT work_id FROM btcc_guided_works WHERE session_id=?1 AND status IN ('open','blocked')",
    ).map_err(StorageError::sqlite)?.query_map([session], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for id in works {
        relation::abandon(db, &id, &|| now.into())?;
    }
    Ok(())
}

pub(super) fn close_actions(db: &Connection, id: &str, now: &str) -> StorageResult<()> {
    let work = read::view(db, id)?;
    if let Some(plan) = &work.current_plan {
        let mut actions = work.action_progress.clone();
        for action in &mut actions {
            if !matches!(action.status, ActionStatus::Done | ActionStatus::Skipped) {
                action.status = ActionStatus::Skipped;
                action.note = Some("Work ended.".into());
            }
        }
        mutation::insert_progress(
            db,
            mutation::ProgressInput {
                work_id: id,
                plan_revision_id: &plan.plan_revision_id,
                stage: WorkStage::Reporting,
                actions: &actions,
                summary: "Work ended.",
                next: "",
                result_sequence: common::latest_result_sequence(db, id)?,
                origin_turn_id: &work.origin.turn_id,
                identity: &format!("work-abandon:{id}"),
                now,
            },
        )?;
    }
    Ok(())
}

pub(in crate::btcc::storage) fn invariant(db: &Connection, session: &str) -> StorageResult<bool> {
    let ids = db
        .prepare_cached("SELECT work_id FROM btcc_guided_works WHERE session_id=?1")
        .map_err(StorageError::sqlite)?
        .query_map([session], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for id in ids {
        let view = read::view(db, &id)?;
        if matches!(
            view.status,
            crate::btcc::DurableWorkStatus::Open | crate::btcc::DurableWorkStatus::Blocked
        ) || view
            .action_progress
            .iter()
            .any(|a| !matches!(a.status, ActionStatus::Done | ActionStatus::Skipped))
        {
            return Ok(false);
        }
    }
    Ok(true)
}
