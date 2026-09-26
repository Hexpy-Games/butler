use rusqlite::{Connection, params};

use crate::btcc::work::{ActionProgress, WorkStage};

use super::super::{StorageError, StorageResult, common};
use crate::btcc::StorageCode;

#[derive(Clone, Copy)]
pub(in crate::btcc::storage::work) struct ProgressInput<'a> {
    pub work_id: &'a str,
    pub plan_revision_id: &'a str,
    pub stage: WorkStage,
    pub actions: &'a [ActionProgress],
    pub summary: &'a str,
    pub next: &'a str,
    pub result_sequence: u64,
    pub origin_turn_id: &'a str,
    pub identity: &'a str,
    pub now: &'a str,
}

pub(in crate::btcc::storage::work) fn assert_progress_revision(
    db: &Connection,
    work_id: &str,
    expected: u64,
) -> StorageResult<()> {
    let current: u64 = db.query_row("SELECT COALESCE(MAX(revision), 0) FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?1", [work_id], |row| row.get(0)).map_err(StorageError::sqlite)?;
    if current != expected {
        return Err(common::error(
            StorageCode::DurableWorkProgressChanged,
            "Durable Work progress changed; use the current Work view",
        ));
    }
    Ok(())
}

pub(in crate::btcc::storage::work) fn insert_progress(
    db: &Connection,
    input: ProgressInput<'_>,
) -> StorageResult<String> {
    let revision =
        common::next_revision(db, "btcc_guided_work_checkpoint_revisions", input.work_id)?;
    let id = common::record_id("checkpoint", input.identity);
    db.execute("INSERT INTO btcc_guided_work_checkpoint_revisions (checkpoint_revision_id, work_id, revision, plan_revision_id, stage, public_summary, next_step, action_states_json, result_sequence, origin_turn_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)", params![id, input.work_id, revision, input.plan_revision_id, common::enum_text(input.stage)?, input.summary, input.next, common::stable(&input.actions)?, input.result_sequence, input.origin_turn_id, input.now]).map_err(StorageError::sqlite)?;
    Ok(id)
}
