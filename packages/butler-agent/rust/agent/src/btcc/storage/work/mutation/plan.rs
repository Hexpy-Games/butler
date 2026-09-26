use rusqlite::{Connection, params};

use crate::btcc::work::{ReplacePlanCommand, WorkStage, WorkView};

use super::super::{StorageError, StorageResult, common, read, relation, tool_result};
use super::{ProgressInput, assert_progress_revision, insert_progress, record, replay};

pub(in crate::btcc::storage::work) fn replace_plan(
    db: &Connection,
    command: &ReplacePlanCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<WorkView> {
    let input = &command.input;
    if let Some(work_id) = replay(
        db,
        &input.mutation_call_id,
        "replace_plan",
        &command.request_sha256,
    )? {
        tool_result::backfill(
            db,
            &work_id,
            &input.scope,
            &input.mutation_call_id,
            input.backfill_tool_call_ids.as_deref().unwrap_or(&[]),
            clock,
        )?;
        return read::view(db, &work_id);
    }
    let work = relation::select_for_plan(db, command, clock)?;
    tool_result::backfill(
        db,
        &work.id,
        &input.scope,
        &input.mutation_call_id,
        input.backfill_tool_call_ids.as_deref().unwrap_or(&[]),
        clock,
    )?;
    if command
        .expected_work_id
        .as_ref()
        .is_some_and(|id| id != &work.id)
    {
        return Err(common::error(
            "durable_work_plan_changed",
            "Durable Work changed before its Plan update",
        ));
    }
    if let Some(expected) = command.expected_progress_revision {
        assert_progress_revision(db, &work.id, expected)?;
    }
    let revision = common::next_revision(db, "btcc_guided_work_plan_revisions", &work.id)?;
    let plan_id = common::record_id("plan", &input.mutation_call_id);
    let now = clock();
    db.execute("INSERT INTO btcc_guided_work_plan_revisions (plan_revision_id, work_id, revision, objective, governing_refs_json, execution_mode, actions_json, checks_json, origin_turn_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![plan_id, work.id, revision, input.objective, common::stable(&command.governing_refs)?, input.execution_mode.map(common::enum_text).transpose()?, common::stable(&input.actions)?, common::stable(&input.checks)?, input.scope.turn_id, now]).map_err(StorageError::sqlite)?;
    let result_sequence = common::latest_result_sequence(db, &work.id)?;
    let next = input
        .actions
        .first()
        .map_or("", |action| action.description.as_str());
    if command.opening_plan {
        insert_progress(
            db,
            ProgressInput {
                work_id: &work.id,
                plan_revision_id: &plan_id,
                stage: WorkStage::Conception,
                actions: &command.action_progress,
                summary: &input.objective,
                next,
                result_sequence,
                origin_turn_id: &input.scope.turn_id,
                identity: &format!("{}\0conception", input.mutation_call_id),
                now: &now,
            },
        )?;
    }
    insert_progress(
        db,
        ProgressInput {
            work_id: &work.id,
            plan_revision_id: &plan_id,
            stage: WorkStage::Planning,
            actions: &command.action_progress,
            summary: &input.objective,
            next,
            result_sequence,
            origin_turn_id: &input.scope.turn_id,
            identity: &format!("{}\0plan", input.mutation_call_id),
            now: &now,
        },
    )?;
    let status = if command
        .action_progress
        .iter()
        .any(|action| action.status == crate::btcc::work::ActionStatus::Blocked)
    {
        "blocked"
    } else {
        "open"
    };
    let changed = db.execute("UPDATE btcc_guided_works SET current_plan_revision_id = ?1, status = ?2, updated_at = ?3 WHERE work_id = ?4", params![plan_id, status, now, work.id]).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(common::error(
            "durable_work_plan_lost",
            "Durable Work Plan lost its Work",
        ));
    }
    common::preserve_blocked(db, &work.id, clock)?;
    record(
        db,
        &input.mutation_call_id,
        "replace_plan",
        &command.request_sha256,
        &work.id,
        &plan_id,
        clock,
    )?;
    read::view(db, &work.id)
}
