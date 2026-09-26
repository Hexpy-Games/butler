use rusqlite::{Connection, params};

use crate::btcc::work::{ActionStatus, CheckpointCommand, WorkView};

use super::super::{StorageError, StorageResult, common, read, relation};
use super::{ProgressInput, assert_progress_revision, insert_progress, record, replay};

pub(in crate::btcc::storage::work) fn record_checkpoint(
    db: &Connection,
    command: &CheckpointCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<WorkView> {
    let input = &command.input;
    if let Some(work_id) = replay(
        db,
        &input.mutation_call_id,
        "record_checkpoint",
        &command.request_sha256,
    )? {
        return read::view(db, &work_id);
    }
    let work = relation::require_bound(db, &input.scope, false)?;
    if work.current_plan_revision_id.as_deref() != Some(&command.expected_plan_revision_id) {
        return Err(common::error(
            "durable_work_plan_changed",
            "Durable Work Plan changed before its progress update",
        ));
    }
    assert_progress_revision(db, &work.id, command.expected_progress_revision)?;
    let now = clock();
    let checkpoint_id = insert_progress(
        db,
        ProgressInput {
            work_id: &work.id,
            plan_revision_id: &command.expected_plan_revision_id,
            stage: command.stage,
            actions: &command.action_progress,
            summary: &command.public_summary,
            next: &command.next_step,
            result_sequence: common::latest_result_sequence(db, &work.id)?,
            origin_turn_id: &input.scope.turn_id,
            identity: &input.mutation_call_id,
            now: &now,
        },
    )?;
    let status = if command
        .action_progress
        .iter()
        .any(|action| action.status == ActionStatus::Blocked)
    {
        "blocked"
    } else {
        "open"
    };
    db.execute(
        "UPDATE btcc_guided_works SET status = ?1, updated_at = ?2 WHERE work_id = ?3",
        params![status, now, work.id],
    )
    .map_err(StorageError::sqlite)?;
    common::preserve_blocked(db, &work.id, clock)?;
    record(
        db,
        &input.mutation_call_id,
        "record_checkpoint",
        &command.request_sha256,
        &work.id,
        &checkpoint_id,
        clock,
    )?;
    read::view(db, &work.id)
}
