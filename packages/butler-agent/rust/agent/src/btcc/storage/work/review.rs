use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{ActionStatus, ReviewCommand, ReviewSubject, WorkView};

use super::{StorageError, StorageResult, common, mutation, read, relation};
use crate::btcc::StorageCode;
use mutation::{ProgressInput, assert_progress_revision, insert_progress};

pub(super) fn record(
    db: &Connection,
    command: &ReviewCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<WorkView> {
    let input = &command.input;
    if let Some(work_id) = mutation::replay(
        db,
        &input.mutation_call_id,
        "record_review",
        &command.request_sha256,
    )? {
        return read::view(db, &work_id);
    }
    let work = relation::require_bound(db, &input.scope, false)?;
    if input.subject == ReviewSubject::Plan && work.current_plan_revision_id.is_none() {
        return Err(common::error(
            StorageCode::DurableWorkPlanReviewMissing,
            "Durable Work Plan Review requires a current Plan",
        ));
    }
    if work.current_plan_revision_id.as_deref() != Some(command.expected_plan_revision_id.as_str())
    {
        return Err(common::error(
            StorageCode::DurableWorkPlanChanged,
            "Durable Work Plan changed before its Review",
        ));
    }
    assert_progress_revision(db, &work.id, command.expected_progress_revision)?;
    if common::latest_result_sequence(db, &work.id)? != command.expected_result_sequence {
        return Err(common::error(
            StorageCode::DurableWorkResultsChanged,
            "Durable Work results changed before its Review",
        ));
    }
    assert_completion_review(db, &work.id, command)?;
    let now = clock();
    let next = input.corrections.first().map_or("", String::as_str);
    if input.subject == ReviewSubject::Completion
        || command.current_stage != command.entry_stage
        || command.progress_changed
    {
        insert_progress(
            db,
            ProgressInput {
                work_id: &work.id,
                plan_revision_id: &command.expected_plan_revision_id,
                stage: command.entry_stage,
                actions: &command.action_progress,
                summary: &input.summary,
                next,
                result_sequence: command.expected_result_sequence,
                origin_turn_id: &input.scope.turn_id,
                identity: &format!(
                    "{}\0{}-entry",
                    input.mutation_call_id,
                    common::enum_text(command.entry_stage)?
                ),
                now: &now,
            },
        )?;
    }
    let id = common::record_id("review", &input.mutation_call_id);
    let result_sequence =
        (input.subject != ReviewSubject::Plan).then_some(command.expected_result_sequence);
    let plan_id = (input.subject != ReviewSubject::Result)
        .then_some(command.expected_plan_revision_id.as_str());
    let result_review_id = (input.subject == ReviewSubject::Completion)
        .then_some(command.expected_result_review_revision_id.as_deref())
        .flatten();
    let action_states = (input.subject == ReviewSubject::Completion)
        .then(|| common::stable(&command.action_progress))
        .transpose()?;
    db.execute("INSERT INTO btcc_guided_work_review_revisions (review_revision_id, work_id, revision, subject, verdict, summary, corrections_json, bound_plan_revision_id, bound_result_sequence, bound_result_review_revision_id, bound_action_states_json, origin_turn_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)", params![id, work.id, common::next_revision(db, "btcc_guided_work_review_revisions", &work.id)?, common::enum_text(input.subject)?, common::enum_text(input.verdict)?, input.summary, common::stable(&input.corrections)?, plan_id, result_sequence, result_review_id, action_states, input.scope.turn_id, now]).map_err(StorageError::sqlite)?;
    if command.next_stage != command.entry_stage {
        insert_progress(
            db,
            ProgressInput {
                work_id: &work.id,
                plan_revision_id: &command.expected_plan_revision_id,
                stage: command.next_stage,
                actions: &command.action_progress,
                summary: &input.summary,
                next,
                result_sequence: command.expected_result_sequence,
                origin_turn_id: &input.scope.turn_id,
                identity: &format!(
                    "{}\0{}-exit",
                    input.mutation_call_id,
                    common::enum_text(command.entry_stage)?
                ),
                now: &now,
            },
        )?;
    }
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
    db.execute(
        "UPDATE btcc_guided_works SET updated_at = ?1 WHERE work_id = ?2",
        params![now, work.id],
    )
    .map_err(StorageError::sqlite)?;
    mutation::record(
        db,
        &input.mutation_call_id,
        "record_review",
        &command.request_sha256,
        &work.id,
        &id,
        clock,
    )?;
    read::view(db, &work.id)
}

fn assert_completion_review(
    db: &Connection,
    work_id: &str,
    command: &ReviewCommand,
) -> StorageResult<()> {
    if command.input.subject != ReviewSubject::Completion {
        return Ok(());
    }
    let expected = command
        .expected_result_review_revision_id
        .as_deref()
        .ok_or_else(|| {
            common::error(
                StorageCode::DurableWorkResultReviewMissing,
                "Durable Work completion requires an accepted result Review",
            )
        })?;
    let row = db.query_row("SELECT review_revision_id, verdict, bound_result_sequence FROM btcc_guided_work_review_revisions WHERE work_id = ?1 AND subject = 'result' ORDER BY revision DESC LIMIT 1", [work_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<u64>>(2)?)))
        .optional().map_err(StorageError::sqlite)?;
    if !row.is_some_and(|(id, verdict, sequence)| {
        id == expected && verdict == "accept" && sequence == Some(command.expected_result_sequence)
    }) {
        return Err(common::error(
            StorageCode::DurableWorkResultReviewChanged,
            "Durable Work result Review changed before completion Validation",
        ));
    }
    Ok(())
}
