use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ActionProgress, DispositionCommand, DispositionStatus, OriginalRequest,
    ProjectWorkCanonicalLocation, ProjectWorkDispositionPreparation, ProjectWorkLocateInput,
    ProjectWorkOperationIdentity, WorkResultFact, WorkStatus, WorkTurnScope, WorkView,
};

use super::super::{StorageError, StorageResult};

fn invalid(code: &'static str) -> StorageError {
    StorageError::new(code, code)
}

pub(super) fn locate(
    db: &Connection,
    input: &ProjectWorkLocateInput,
) -> StorageResult<ProjectWorkCanonicalLocation> {
    let session_head_work_id = input
        .session_id
        .as_deref()
        .map(|session| {
            db.query_row(
                "SELECT head.work_id FROM btcc_guided_work_session_heads head \
             JOIN btcc_guided_works work ON work.work_id=head.work_id \
             WHERE head.session_id=?1 AND work.scope_kind='project' \
             AND work.scope_ref=?2 AND work.ledger_project_id=?3 \
             AND work.canonical_head_sha256 IS NOT NULL",
                params![
                    session,
                    input.scope.app_project_id,
                    input.scope.ledger_project_id
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StorageError::sqlite)
        })
        .transpose()?
        .flatten();
    let binding_work_id = input
        .turn_id
        .as_deref()
        .map(|turn| {
            db.query_row(
                "SELECT binding.work_id FROM btcc_guided_turn_work_bindings binding \
             JOIN btcc_guided_works work ON work.work_id=binding.work_id \
             WHERE binding.turn_id=?1 AND binding.is_current=1 \
             AND work.scope_kind='project' AND work.scope_ref=?2 \
             AND work.ledger_project_id=?3 AND work.canonical_head_sha256 IS NOT NULL",
                params![
                    turn,
                    input.scope.app_project_id,
                    input.scope.ledger_project_id
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StorageError::sqlite)
        })
        .transpose()?
        .flatten();
    Ok(ProjectWorkCanonicalLocation {
        session_head_work_id,
        binding_work_id,
    })
}

pub(super) fn original_request(
    db: &Connection,
    scope: &WorkTurnScope,
) -> StorageResult<OriginalRequest> {
    let row = db.query_row(
        "SELECT session_id,original_message_id,original_message FROM btcc_turns WHERE turn_id=?1",
        [&scope.turn_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    ).optional().map_err(StorageError::sqlite)?;
    let Some((session, message_id, content)) = row else {
        return Err(invalid("project_work_runtime_origin_missing"));
    };
    if session != scope.session_id {
        return Err(invalid("project_work_runtime_origin_missing"));
    }
    Ok(OriginalRequest {
        turn_id: scope.turn_id.clone(),
        message_id,
        content,
    })
}

pub(super) fn result_facts(db: &Connection, work_id: &str) -> StorageResult<Vec<WorkResultFact>> {
    // The source takes the last 50 after sequence order; reverse a bounded tail.
    let mut statement = db
        .prepare(
            "SELECT result.result_ref,call.tool_name,call.status,call.result_json,call.error_code \
         FROM btcc_guided_work_results result JOIN btcc_guided_tool_calls call \
         ON call.call_id=result.tool_call_id WHERE result.work_id=?1 \
         ORDER BY result.sequence DESC LIMIT 50",
        )
        .map_err(StorageError::sqlite)?;
    let mut rows = statement
        .query_map([work_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .map(|row| {
            let (result_ref, tool_name, status, result_json, error_code) =
                row.map_err(StorageError::sqlite)?;
            let result_json = result_json
                .filter(|s| !s.is_empty())
                .map(|s| serde_json::from_str(&s))
                .transpose()
                .map_err(|_| invalid("project_work_runtime_result_invalid"))?;
            Ok(WorkResultFact {
                result_ref: Some(result_ref),
                tool_name,
                status,
                result_json,
                error_code: error_code.filter(|s| !s.is_empty()),
            })
        })
        .collect::<StorageResult<Vec<_>>>()?;
    rows.reverse();
    Ok(rows)
}

pub(super) fn operation_recorded_at(
    db: &Connection,
    identity: &ProjectWorkOperationIdentity,
) -> StorageResult<Option<String>> {
    identity
        .mutation_call_id
        .as_deref()
        .map(|id| {
            db.query_row(
                "SELECT started_at FROM btcc_guided_tool_calls WHERE call_id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StorageError::sqlite)
        })
        .transpose()
        .map(std::option::Option::flatten)
}

pub(super) fn prepare_disposition(
    db: &Connection,
    command: &DispositionCommand,
    current: &WorkView,
) -> StorageResult<ProjectWorkDispositionPreparation> {
    let fresh = command.input.disposition == DispositionStatus::Open
        && current.status == WorkStatus::Completed
        && command
            .input
            .runtime_owned_open_generation
            .is_some_and(|v| v.version == 1)
        && current.latest_disposition.as_ref().is_some_and(|latest| {
            latest.origin_turn_id == command.input.scope.turn_id
                && latest.disposition == DispositionStatus::Completed
                && crate::btcc::work::policy::disposition_material_fingerprint(current)
                    .is_ok_and(|fingerprint| latest.material_fingerprint == fingerprint)
        });
    if fresh {
        return Ok(ProjectWorkDispositionPreparation::CurrentView);
    }
    let action_progress = if command.action_updates.is_empty() {
        current.action_progress.clone()
    } else {
        let updates = command
            .action_updates
            .iter()
            .map(|item| ActionProgress {
                action_key: item.action_key.clone(),
                status: item.status,
                note: item.note.clone(),
            })
            .collect::<Vec<_>>();
        crate::btcc::work::policy::apply_work_action_updates(current, &updates)
            .map_err(|e| StorageError::new("project_work_progress_invalid", e.message))?
    };
    if command.input.disposition == DispositionStatus::Completed {
        let blocker = db.query_row(
            "SELECT 1 FROM btcc_guided_work_effect_blockers WHERE work_id=?1 AND status='unresolved' LIMIT 1",
            [&current.work_id], |row| row.get::<_, i64>(0),
        ).optional().map_err(StorageError::sqlite)?;
        if blocker.is_some() {
            return Err(invalid("project_work_effect_unresolved"));
        }
    }
    let evidence_snapshot = super::super::work::resolve_work_evidence(
        db,
        &current.work_id,
        &command.input.scope.turn_id,
        &command.evidence_refs,
    )?;
    Ok(ProjectWorkDispositionPreparation::Apply {
        action_progress,
        evidence_snapshot,
    })
}
