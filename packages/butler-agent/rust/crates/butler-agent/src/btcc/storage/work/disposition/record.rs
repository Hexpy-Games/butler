use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ActionProgress, ActionStatus, DispositionCommand, DispositionStatus, WorkStatus, WorkView,
};

use super::super::{StorageError, StorageResult, common, mutation, read, relation, tool_result};
use super::{evidence, replay};
use crate::btcc::StorageCode;
use mutation::{ProgressInput, insert_progress};

pub(in crate::btcc::storage::work) fn record(
    db: &Connection,
    command: &DispositionCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<WorkView> {
    let input = &command.input;
    if let Some(work_id) = replay(
        db,
        &input.mutation_call_id,
        &command.request_sha256,
        &input.work_id,
    )? {
        return read::view(db, &work_id);
    }
    let runtime_owned_open = input.disposition == DispositionStatus::Open
        && input
            .runtime_owned_open_generation
            .is_some_and(|value| value.version == 1);
    let work = relation::require_bound(db, &input.scope, runtime_owned_open)?;
    if work.id != input.work_id {
        return Err(common::error(
            StorageCode::DurableWorkDispositionNotBound,
            "Durable Work disposition target is not bound to this Turn",
        ));
    }
    attach_current_turn(db, &work.id, command, clock)?;
    let current = read::view(db, &work.id)?;
    let transition = runtime_completed_transition(command, &current)?;
    if transition == RuntimeTransition::FreshCompleted {
        return Ok(current);
    }
    validate_expected_material(command, &current)?;
    let action_progress = if command.action_updates.is_empty() {
        current.action_progress.clone()
    } else {
        let updates = command
            .action_updates
            .iter()
            .map(|update| ActionProgress {
                action_key: update.action_key.clone(),
                status: update.status,
                note: update.note.clone(),
            })
            .collect::<Vec<_>>();
        crate::btcc::work::policy::apply_work_action_updates(&current, &updates).map_err(
            |error| common::error(StorageCode::DurableWorkProgressInvalid, error.message()),
        )?
    };
    let remaining = evidence::normalize_list(&command.remaining_actions);
    let next_condition = evidence::normalize_optional(input.next_condition.as_deref());
    let evidence_refs = evidence::normalize_list(&command.evidence_refs);
    let followups = evidence::normalize_list(&command.followups);
    let snapshot = evidence::resolve(db, &work.id, &input.scope.turn_id, &evidence_refs)?;
    validate_disposition(
        db,
        command,
        &action_progress,
        &remaining,
        next_condition.as_deref(),
        &work.id,
    )?;
    let now = clock();
    let revision = common::next_revision(db, "btcc_guided_work_disposition_revisions", &work.id)?;
    let result_sequence = common::latest_result_sequence(db, &work.id)?;
    let disposition_id = common::record_id("disposition", &input.mutation_call_id);
    db.execute("INSERT INTO btcc_guided_work_disposition_revisions (disposition_revision_id, work_id, revision, result_sequence, disposition, summary, material_fingerprint, runtime_owned_open, action_updates_json, remaining_actions_json, next_condition, evidence_refs_json, evidence_snapshot_json, followups_json, origin_turn_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)", params![disposition_id, work.id, revision, result_sequence, common::enum_text(input.disposition)?, command.normalized_summary, i32::from(runtime_owned_open), common::stable(&command.action_updates)?, common::stable(&remaining)?, next_condition, common::stable(&evidence_refs)?, common::stable(&snapshot)?, common::stable(&followups)?, input.scope.turn_id, now]).map_err(StorageError::sqlite)?;
    if let Some(plan) = &current.current_plan {
        let next = remaining
            .first()
            .map(String::as_str)
            .or(next_condition.as_deref())
            .unwrap_or("");
        insert_progress(
            db,
            ProgressInput {
                work_id: &work.id,
                plan_revision_id: &plan.plan_revision_id,
                stage: current
                    .current_stage
                    .unwrap_or(crate::btcc::work::WorkStage::Planning),
                actions: &action_progress,
                summary: &command.normalized_summary,
                next,
                result_sequence: common::latest_result_sequence(db, &work.id)?,
                origin_turn_id: &input.scope.turn_id,
                identity: &format!("{}\0disposition", input.mutation_call_id),
                now: &now,
            },
        )?;
    }
    db.execute("UPDATE btcc_guided_works SET status = ?1, updated_at = ?2 WHERE work_id = ?3 AND (status IN ('open', 'blocked') OR (?4 = 1 AND status = 'completed'))", params![common::enum_text(input.disposition)?, now, work.id, i32::from(transition == RuntimeTransition::Reopen)]).map_err(StorageError::sqlite)?;
    db.execute("INSERT INTO btcc_guided_work_disposition_commands (mutation_call_id, request_sha256, work_id, disposition_revision_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![input.mutation_call_id, command.request_sha256, work.id, disposition_id, now]).map_err(StorageError::sqlite)?;
    let persisted = read::view(db, &work.id)?;
    let fingerprint = material_fingerprint(&persisted)?;
    db.execute("UPDATE btcc_guided_work_disposition_revisions SET material_fingerprint = ?1 WHERE disposition_revision_id = ?2", params![fingerprint, disposition_id]).map_err(StorageError::sqlite)?;
    read::view(db, &work.id)
}

fn attach_current_turn(
    db: &Connection,
    work_id: &str,
    command: &DispositionCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    let input = &command.input;
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for id in input.backfill_tool_call_ids.as_deref().unwrap_or(&[]) {
        if seen.insert(id.clone()) {
            ids.push(id.clone());
        }
    }
    let mut statement = db.prepare("SELECT call_id, tool_name FROM btcc_guided_tool_calls WHERE turn_id = ?1 AND status = 'completed' ORDER BY rowid").map_err(StorageError::sqlite)?;
    for result in statement
        .query_map([&input.scope.turn_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(StorageError::sqlite)?
    {
        let (id, name) = result.map_err(StorageError::sqlite)?;
        if !tool_result::CONTROL_TOOLS.contains(&name.as_str()) && seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    for call_id in ids {
        let existing: Option<String> = db
            .query_row(
                "SELECT work_id FROM btcc_guided_work_results WHERE tool_call_id = ?1",
                [&call_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::sqlite)?;
        if existing.as_ref().is_some_and(|other| other != work_id) {
            return Err(common::error(
                StorageCode::DurableWorkResultOther,
                "Durable Work tool result is already bound to another Work",
            ));
        }
        if existing.is_some() {
            continue;
        }
        tool_result::attach(db, work_id, &input.scope.turn_id, &call_id, clock)?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeTransition {
    None,
    FreshCompleted,
    Reopen,
}

fn runtime_completed_transition(
    command: &DispositionCommand,
    current: &WorkView,
) -> StorageResult<RuntimeTransition> {
    let input = &command.input;
    if input.disposition != DispositionStatus::Open
        || current.status != WorkStatus::Completed
        || input
            .runtime_owned_open_generation
            .is_none_or(|v| v.version != 1)
        || input.expected_material_fingerprint.is_none()
    {
        return Ok(RuntimeTransition::None);
    }
    let latest = current.latest_disposition.as_ref();
    let fingerprint = material_fingerprint(current)?;
    let fresh = latest.is_some_and(|latest| {
        latest.origin_turn_id == input.scope.turn_id
            && latest.disposition == DispositionStatus::Completed
            && latest.material_fingerprint == fingerprint
    });
    Ok(if fresh {
        RuntimeTransition::FreshCompleted
    } else {
        RuntimeTransition::Reopen
    })
}

fn validate_expected_material(
    command: &DispositionCommand,
    current: &WorkView,
) -> StorageResult<()> {
    if let Some(expected) = &command.input.expected_material_fingerprint
        && material_fingerprint(current)? != *expected
    {
        return Err(common::error(
            StorageCode::DurableWorkMaterialChanged,
            "Durable Work changed before its disposition was persisted",
        ));
    }
    Ok(())
}

fn material_fingerprint(work: &WorkView) -> StorageResult<String> {
    crate::btcc::work::policy::disposition_material_fingerprint(work).map_err(|error| {
        common::error(StorageCode::DurableWorkMaterialFingerprint, error.message())
    })
}

fn validate_disposition(
    db: &Connection,
    command: &DispositionCommand,
    actions: &[ActionProgress],
    remaining: &[String],
    next: Option<&str>,
    work_id: &str,
) -> StorageResult<()> {
    match command.input.disposition {
        DispositionStatus::Completed => {
            if !remaining.is_empty() {
                return Err(common::error(
                    StorageCode::DurableWorkRemainingActions,
                    "Completed Work cannot have remaining actions",
                ));
            }
            if actions
                .iter()
                .any(|action| !matches!(action.status, ActionStatus::Done | ActionStatus::Skipped))
            {
                return Err(common::error(
                    StorageCode::DurableWorkNonterminalActions,
                    format!("Completed Work has nonterminal actions: {work_id}"),
                ));
            }
            if common::effect_blocked(db, work_id)? {
                return Err(common::error(
                    StorageCode::DurableWorkEffectBlocker,
                    "Completed Work has an unresolved effect blocker",
                ));
            }
            let pending: Option<i64> = db.query_row("SELECT 1 FROM btcc_guided_effects WHERE work_id = ?1 AND status IN ('pending', 'prepared', 'dispatching', 'uncertain') LIMIT 1", [work_id], |row| row.get(0)).optional().map_err(StorageError::sqlite)?;
            if pending.is_some() {
                return Err(common::error(
                    StorageCode::DurableWorkPendingEffect,
                    "Completed Work has a pending effect",
                ));
            }
        }
        DispositionStatus::Open | DispositionStatus::Blocked => {
            if remaining.is_empty() && next.is_none() {
                return Err(common::error(
                    StorageCode::DurableWorkNextMissing,
                    format!(
                        "{} Work requires remaining actions or a next condition",
                        common::enum_text(command.input.disposition)?
                    ),
                ));
            }
            if command.input.disposition == DispositionStatus::Blocked && next.is_none() {
                return Err(common::error(
                    StorageCode::DurableWorkBlockedNextMissing,
                    "Blocked Work requires a concrete next condition",
                ));
            }
        }
    }
    Ok(())
}
