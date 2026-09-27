use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{LegacyImport, WorkTurnScope};

use super::super::{StorageError, StorageResult, common, read};
use super::projection::Projection;
use crate::btcc::StorageCode;

pub(super) fn import(
    db: &Connection,
    scope: &WorkTurnScope,
    program_id: &str,
    source_revision: u64,
    projection: &Projection,
    origin: &common::TurnRow,
    clock: &dyn Fn() -> String,
) -> StorageResult<Option<LegacyImport>> {
    common::relation_turn(db, scope)?;
    if origin.session_id != scope.session_id {
        return Err(common::error(
            StorageCode::DurableWorkLegacyOriginSession,
            "Legacy Work origin belongs to another Session",
        ));
    }
    let import_id = import_id(program_id, scope);
    if let Some(replay) = replay(db, scope, program_id, &import_id, clock)? {
        return Ok(Some(replay));
    }
    if common::head(db, &scope.session_id)?.is_some_and(|head| head.is_open()) {
        return Ok(None);
    }
    let work_id = common::record_id("work", &import_id);
    let plan_id = (!projection.actions.is_empty()).then(|| common::record_id("plan", &import_id));
    let checkpoint_id = projection
        .checkpoint
        .as_ref()
        .zip(plan_id.as_ref())
        .map(|_| common::record_id("checkpoint", &import_id));
    let now = clock();
    db.execute("INSERT INTO btcc_guided_works (work_id, session_id, scope_kind, scope_ref, origin_turn_id, origin_message_id, objective, status, current_plan_revision_id, created_at, updated_at) VALUES (?1, ?2, 'session', ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?7)", params![work_id, scope.session_id, origin.id, origin.message_id, projection.objective, plan_id, now]).map_err(StorageError::sqlite)?;
    if let Some(plan_id) = &plan_id {
        db.execute("INSERT INTO btcc_guided_work_plan_revisions (plan_revision_id, work_id, revision, objective, governing_refs_json, actions_json, checks_json, origin_turn_id, created_at) VALUES (?1, ?2, 1, ?3, '[]', ?4, ?5, ?6, ?7)", params![plan_id, work_id, projection.objective, common::stable(&projection.actions)?, common::stable(&projection.checks)?, origin.id, now]).map_err(StorageError::sqlite)?;
    }
    if let (Some(checkpoint), Some(checkpoint_id), Some(plan_id)) =
        (&projection.checkpoint, &checkpoint_id, &plan_id)
    {
        db.execute("INSERT INTO btcc_guided_work_checkpoint_revisions (checkpoint_revision_id, work_id, revision, plan_revision_id, stage, public_summary, next_step, action_states_json, result_sequence, origin_turn_id, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)", params![checkpoint_id, work_id, plan_id, common::enum_text(checkpoint.stage)?, checkpoint.summary, checkpoint.next, common::stable(&checkpoint.actions)?, origin.id, now]).map_err(StorageError::sqlite)?;
    }
    db.execute("INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET work_id = excluded.work_id, updated_at = excluded.updated_at", params![scope.session_id, work_id, now]).map_err(StorageError::sqlite)?;
    db.execute("INSERT INTO btcc_guided_work_legacy_imports (import_id, legacy_program_id, session_id, scope_kind, scope_ref, source_authority, source_revision, work_id, imported_at) VALUES (?1, ?2, ?3, 'session', ?3, 'session_sqlite', ?4, ?5, ?6)", params![import_id, program_id, scope.session_id, source_revision.to_string(), work_id, now]).map_err(StorageError::sqlite)?;
    bind_effect_blockers(
        db,
        &work_id,
        &scope.session_id,
        program_id,
        Some(&origin.id),
        clock,
    )?;
    Ok(Some(LegacyImport {
        source_program_id: program_id.into(),
        imported: true,
        work: read::view(db, &work_id)?,
    }))
}

fn replay(
    db: &Connection,
    scope: &WorkTurnScope,
    program_id: &str,
    import_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<Option<LegacyImport>> {
    common::relation_turn(db, scope)?;
    let row = db.query_row("SELECT legacy_program_id, session_id, scope_kind, scope_ref, work_id FROM btcc_guided_work_legacy_imports WHERE import_id = ?1", [import_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))).optional().map_err(StorageError::sqlite)?;
    let Some((stored_program, stored_session, kind, scope_ref, work_id)) = row else {
        return Ok(None);
    };
    if stored_program != program_id
        || stored_session != scope.session_id
        || kind != "session"
        || scope_ref != scope.session_id
    {
        return Err(common::error(
            StorageCode::DurableWorkLegacyIdentityConflict,
            "Legacy Work import identity conflict",
        ));
    }
    bind_effect_blockers(db, &work_id, &scope.session_id, program_id, None, clock)?;
    Ok(Some(LegacyImport {
        source_program_id: stored_program,
        imported: false,
        work: read::view(db, &work_id)?,
    }))
}

fn import_id(program_id: &str, scope: &WorkTurnScope) -> String {
    common::record_id(
        "legacy-import",
        &format!(
            "{program_id}\0{}\0{}",
            scope.session_id,
            scope.project_ref.as_deref().unwrap_or("")
        ),
    )
}

fn bind_effect_blockers(
    db: &Connection,
    work_id: &str,
    session_id: &str,
    program_id: &str,
    origin_turn_id: Option<&str>,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    if let Some(turn_id) = origin_turn_id {
        db.execute("UPDATE btcc_guided_work_effect_blockers SET work_id = ?1 WHERE session_id = ?2 AND status = 'unresolved' AND (source_program_id = ?3 OR source_turn_id = ?4)", params![work_id, session_id, program_id, turn_id]).map_err(StorageError::sqlite)?;
    } else {
        db.execute("UPDATE btcc_guided_work_effect_blockers SET work_id = ?1 WHERE session_id = ?2 AND status = 'unresolved' AND source_program_id = ?3", params![work_id, session_id, program_id]).map_err(StorageError::sqlite)?;
    }
    common::preserve_blocked(db, work_id, clock)
}
