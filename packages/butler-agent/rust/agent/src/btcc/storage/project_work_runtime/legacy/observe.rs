use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ProjectWorkCommittedResultInput, ProjectWorkLegacyInput, ProjectWorkLegacyObserveInput,
    ProjectWorkLegacySourceKind,
};

use super::super::super::{StorageError, StorageResult};
use super::super::result;
use super::{current, import_id, invalid, valid_hash};

pub(super) fn apply(
    db: &Connection,
    input: &ProjectWorkLegacyObserveInput,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    if !valid_hash(&input.canonical_head_sha256) {
        return Err(invalid("project_work_legacy_observation_invalid"));
    }
    match input.snapshot.source_kind {
        ProjectWorkLegacySourceKind::RawR2 => {
            validate_observed_work(db, input)?;
            validate_raw(db, input)?;
        }
        ProjectWorkLegacySourceKind::SqliteR3 => {
            let current = current::capture(
                db,
                &ProjectWorkLegacyInput {
                    scope: input.scope.clone(),
                    resolved_scope: input.resolved_scope.clone(),
                },
            )?;
            if current
                .as_ref()
                .is_none_or(|v| v.source_sha256 != input.snapshot.source_sha256)
            {
                return Err(invalid("project_work_legacy_source_changed"));
            }
        }
    }
    verify_results(db, input)?;
    let work_id = &input.snapshot.work.work_id;
    if input.snapshot.source_kind == ProjectWorkLegacySourceKind::SqliteR3 {
        validate_observed_work(db, input)?;
    }
    let prior = current::import_row(db, work_id)?;
    let id = prior.as_ref().map_or_else(
        || {
            import_id(
                &input.snapshot.source_program_id,
                &input.scope.session_id,
                &input.resolved_scope.app_project_id,
            )
        },
        |row| row.import_id.clone(),
    );
    if input.snapshot.source_kind == ProjectWorkLegacySourceKind::SqliteR3 {
        if let Some(prior) = &prior {
            if prior.legacy_program_id != input.snapshot.source_program_id
                || prior.session_id != input.scope.session_id
                || prior.scope_kind != "project"
                || prior.scope_ref != input.resolved_scope.app_project_id
                || prior.source_authority != "project_ledger"
                || prior.work_id != *work_id
            {
                return Err(invalid("project_work_legacy_identity_conflict"));
            }
        } else if import_id_exists(db, &id)? {
            return Err(invalid("project_work_legacy_identity_conflict"));
        }
    }
    let now = clock();
    if prior.is_some() {
        let changed = db.execute(
            "UPDATE btcc_guided_work_legacy_imports SET source_revision=?1,imported_at=?2 \
             WHERE import_id=?3 AND legacy_program_id=?4 AND session_id=?5 AND scope_kind='project' \
             AND scope_ref=?6 AND source_authority='project_ledger' AND work_id=?7",
            params![input.snapshot.source_sha256, now, id, input.snapshot.source_program_id,
                input.scope.session_id, input.resolved_scope.app_project_id, work_id],
        ).map_err(StorageError::sqlite)?;
        if changed != 1 {
            return Err(invalid("project_work_legacy_identity_conflict"));
        }
    } else {
        db.execute(
            "INSERT INTO btcc_guided_work_legacy_imports \
             (import_id,legacy_program_id,session_id,scope_kind,scope_ref,source_authority,source_revision,work_id,imported_at) \
             VALUES (?1,?2,?3,'project',?4,'project_ledger',?5,?6,?7)",
            params![id, input.snapshot.source_program_id, input.scope.session_id,
                input.resolved_scope.app_project_id, input.snapshot.source_sha256, work_id, now],
        ).map_err(StorageError::sqlite)?;
    }
    for table in [
        "btcc_guided_work_plan_revisions",
        "btcc_guided_work_checkpoint_revisions",
        "btcc_guided_work_review_revisions",
        "btcc_guided_work_disposition_revisions",
        "btcc_guided_work_closeout_diagnostics",
        "btcc_guided_work_disposition_commands",
        "btcc_guided_work_mutations",
        "btcc_guided_work_relation_commands",
    ] {
        db.execute(&format!("DELETE FROM {table} WHERE work_id=?1"), [work_id])
            .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

fn verify_results(db: &Connection, input: &ProjectWorkLegacyObserveInput) -> StorageResult<()> {
    if input.canonical_result_refs != input.snapshot.work.result_refs {
        return Err(invalid("project_work_legacy_result_reference_mismatch"));
    }
    for reference in &input.snapshot.work.result_refs {
        let evidence = result::read_committed(
            db,
            &ProjectWorkCommittedResultInput {
                turn_id: reference.origin_turn_id.clone(),
                session_id: input.snapshot.work.session_id.clone(),
                tool_call_id: reference.tool_call_id.clone(),
            },
        )?;
        if reference.result_ref != super::record_id("result", &reference.tool_call_id)
            || evidence.tool_name != reference.tool_name
            || reference.result_sha256.as_deref() != Some(evidence.result_sha256.as_str())
        {
            return Err(invalid("project_work_legacy_result_invalid"));
        }
    }
    Ok(())
}

fn validate_raw(db: &Connection, input: &ProjectWorkLegacyObserveInput) -> StorageResult<()> {
    let work_id = &input.snapshot.work.work_id;
    if current::has_semantic_rows(db, work_id)? {
        return Err(invalid("project_work_legacy_project_not_observed"));
    }
    for expected in &input.snapshot.bindings {
        let binding = db
            .query_row(
                "SELECT turn_id,session_id,work_id,revision,is_current \
             FROM btcc_guided_turn_work_bindings WHERE binding_revision_id=?1",
                [&expected.binding_revision_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(StorageError::sqlite)?;
        if binding.as_ref().is_none_or(|row| {
            row.0 != expected.turn_id
                || row.1 != input.scope.session_id
                || row.2 != *work_id
                || row.3 != expected.revision
                || row.4 != 1
        }) {
            return Err(invalid("project_work_legacy_binding_invalid"));
        }
    }
    let origin = input
        .snapshot
        .turns
        .iter()
        .find(|turn| turn.turn_id == input.snapshot.work.origin.turn_id);
    let row = db
        .query_row(
            "SELECT session_id,original_message_id FROM btcc_turns WHERE turn_id=?1",
            [&input.snapshot.work.origin.turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if origin.zip(row.as_ref()).is_none_or(|(origin, row)| {
        row.0 != input.scope.session_id
            || row.1 != origin.original_message_id
            || row.1 != input.snapshot.work.origin.message_id
    }) {
        return Err(invalid("project_work_legacy_origin_message_invalid"));
    }
    Ok(())
}

fn validate_observed_work(
    db: &Connection,
    input: &ProjectWorkLegacyObserveInput,
) -> StorageResult<()> {
    let work = observed_work(db, &input.snapshot.work.work_id)?;
    if work.as_ref().is_none_or(|row| {
        row.session_id != input.scope.session_id
            || row.scope_kind != "project"
            || row.scope_ref != input.resolved_scope.app_project_id
            || row.ledger_project_id.as_deref()
                != Some(input.resolved_scope.ledger_project_id.as_str())
            || row.canonical_head_sha256.as_deref() != Some(input.canonical_head_sha256.as_str())
    }) {
        return Err(invalid("project_work_legacy_project_not_observed"));
    }
    Ok(())
}

struct ObservedWork {
    session_id: String,
    scope_kind: String,
    scope_ref: String,
    ledger_project_id: Option<String>,
    canonical_head_sha256: Option<String>,
}

fn observed_work(db: &Connection, work_id: &str) -> StorageResult<Option<ObservedWork>> {
    db.query_row(
        "SELECT session_id,scope_kind,scope_ref,ledger_project_id,canonical_head_sha256 \
         FROM btcc_guided_works WHERE work_id=?1",
        [work_id],
        |row| {
            Ok(ObservedWork {
                session_id: row.get(0)?,
                scope_kind: row.get(1)?,
                scope_ref: row.get(2)?,
                ledger_project_id: row.get(3)?,
                canonical_head_sha256: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::sqlite)
}

fn import_id_exists(db: &Connection, id: &str) -> StorageResult<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM btcc_guided_work_legacy_imports WHERE import_id=?1 LIMIT 1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some())
}
