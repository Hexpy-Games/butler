mod history;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::btcc::work::{
    ProjectWorkBinding, ProjectWorkLegacyInput, ProjectWorkLegacySnapshot,
    ProjectWorkLegacySourceKind, ProjectWorkLegacyTurn,
};

use super::super::super::{StorageError, StorageResult, work::hydrate_work_view};
use super::{import_id, invalid, source_hash};

pub(super) struct LegacyWorkLocator {
    pub work_id: String,
    pub ledger_project_id: Option<String>,
    pub canonical_head_sha256: Option<String>,
}

pub(super) struct LegacyImportRow {
    pub import_id: String,
    pub legacy_program_id: String,
    pub source_revision: String,
    pub work_id: String,
    pub session_id: String,
    pub scope_kind: String,
    pub scope_ref: String,
    pub source_authority: String,
}

pub(super) fn locate(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
) -> StorageResult<Vec<LegacyWorkLocator>> {
    let mut statement = db
        .prepare(
            "SELECT work_id,ledger_project_id,canonical_head_sha256 \
         FROM btcc_guided_works WHERE session_id=?1 AND scope_kind='project' AND scope_ref=?2 \
         AND status IN ('open','blocked','completed') ORDER BY updated_at DESC,work_id",
        )
        .map_err(StorageError::sqlite)?;
    statement
        .query_map(
            params![input.scope.session_id, input.resolved_scope.app_project_id],
            |row| {
                Ok(LegacyWorkLocator {
                    work_id: row.get(0)?,
                    ledger_project_id: row.get(1)?,
                    canonical_head_sha256: row.get(2)?,
                })
            },
        )
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

pub(super) fn import_row(db: &Connection, work_id: &str) -> StorageResult<Option<LegacyImportRow>> {
    db.query_row(
        "SELECT import_id,legacy_program_id,source_revision,work_id,session_id,scope_kind,scope_ref,source_authority \
         FROM btcc_guided_work_legacy_imports WHERE work_id=?1",
        [work_id], |row| Ok(LegacyImportRow {
            import_id: row.get(0)?, legacy_program_id: row.get(1)?, source_revision: row.get(2)?,
            work_id: row.get(3)?, session_id: row.get(4)?, scope_kind: row.get(5)?,
            scope_ref: row.get(6)?, source_authority: row.get(7)?,
        }),
    ).optional().map_err(StorageError::sqlite)
}

pub(super) fn has_semantic_rows(db: &Connection, work_id: &str) -> StorageResult<bool> {
    for table in [
        "btcc_guided_work_plan_revisions",
        "btcc_guided_work_checkpoint_revisions",
        "btcc_guided_work_review_revisions",
        "btcc_guided_work_disposition_revisions",
    ] {
        let query = format!("SELECT 1 FROM {table} WHERE work_id=?1 LIMIT 1");
        if db
            .query_row(&query, [work_id], |row| row.get::<_, i64>(0))
            .optional()
            .map_err(StorageError::sqlite)?
            .is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn preflight(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
    work_id: &str,
    program_id: &str,
    prior: Option<&LegacyImportRow>,
) -> StorageResult<()> {
    let expected = import_id(
        program_id,
        &input.scope.session_id,
        &input.resolved_scope.app_project_id,
    );
    let collision = db.query_row(
        "SELECT import_id,legacy_program_id,source_revision,work_id,session_id,scope_kind,scope_ref,source_authority \
         FROM btcc_guided_work_legacy_imports WHERE import_id=?1",
        [&expected], |row| Ok(LegacyImportRow {
            import_id: row.get(0)?, legacy_program_id: row.get(1)?, source_revision: row.get(2)?,
            work_id: row.get(3)?, session_id: row.get(4)?, scope_kind: row.get(5)?,
            scope_ref: row.get(6)?, source_authority: row.get(7)?,
        }),
    ).optional().map_err(StorageError::sqlite)?;
    let mut query = db.prepare(
        "SELECT import_id,work_id FROM btcc_guided_work_legacy_imports WHERE legacy_program_id=?1 \
         AND session_id=?2 AND scope_kind='project' AND scope_ref=?3",
    ).map_err(StorageError::sqlite)?;
    let tuples = query
        .query_map(
            params![
                program_id,
                input.scope.session_id,
                input.resolved_scope.app_project_id
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    match prior {
        None if collision.is_some() || !tuples.is_empty() => {
            Err(invalid("project_work_legacy_identity_conflict"))
        }
        None => Ok(()),
        Some(prior)
            if prior.import_id == expected
                && collision.as_ref().is_some_and(|row| row.work_id == work_id)
                && prior.legacy_program_id == program_id
                && prior.session_id == input.scope.session_id
                && prior.scope_kind == "project"
                && prior.scope_ref == input.resolved_scope.app_project_id
                && prior.source_authority == "project_ledger"
                && prior.work_id == work_id
                && super::valid_hash(&prior.source_revision)
                && tuples == vec![(expected, work_id.to_owned())] =>
        {
            Ok(())
        }
        Some(_) => Err(invalid("project_work_legacy_identity_conflict")),
    }
}

pub(super) fn capture(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
) -> StorageResult<Option<ProjectWorkLegacySnapshot>> {
    let rows = locate(db, input)?;
    if rows.len() > 1 {
        return Err(invalid("project_work_legacy_multiple_open_works"));
    }
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    if !has_semantic_rows(db, &row.work_id)?
        && row
            .ledger_project_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    {
        return Ok(None);
    }
    if row
        .ledger_project_id
        .as_deref()
        .is_some_and(|id| !id.is_empty() && id != input.resolved_scope.ledger_project_id)
    {
        return Err(invalid("project_work_legacy_scope_conflict"));
    }
    let mut work = hydrate_work_view(db, &row.work_id)?;
    let bindings = bindings(db, &row.work_id, &input.scope.session_id)?;
    let required_turn_ids = required_turn_ids(db, &work, &bindings)?;
    if required_turn_ids
        .iter()
        .any(|id| !bindings.iter().any(|binding| binding.turn_id == *id))
    {
        return Err(invalid("project_work_legacy_binding_missing"));
    }
    let plans = history::plans(db, &row.work_id)?;
    let checkpoints = history::checkpoints(db, &row.work_id, &plans)?;
    let source_reviews = history::reviews(db, &row.work_id, &checkpoints, false)?;
    let reviews = history::reviews(db, &row.work_id, &checkpoints, true)?;
    work.latest_checkpoint = checkpoints.last().map(|item| item.checkpoint.clone());
    work.latest_plan_review = reviews
        .iter()
        .rev()
        .find(|v| matches!(v.subject, crate::btcc::work::ReviewSubject::Plan))
        .cloned();
    work.latest_result_review = reviews
        .iter()
        .rev()
        .find(|v| matches!(v.subject, crate::btcc::work::ReviewSubject::Result))
        .cloned();
    work.latest_completion_validation = reviews
        .iter()
        .rev()
        .find(|v| matches!(v.subject, crate::btcc::work::ReviewSubject::Completion))
        .cloned();
    let dispositions = history::dispositions(db, &work, &plans, &checkpoints, &source_reviews)?;
    let turns = turns(db, &required_turn_ids, &input.scope.session_id)?;
    let prior = import_row(db, &row.work_id)?;
    let source_program_id = prior.as_ref().map_or_else(
        || format!("current-r3:{}", row.work_id),
        |v| v.legacy_program_id.clone(),
    );
    preflight(db, input, &row.work_id, &source_program_id, prior.as_ref())?;
    if turns
        .iter()
        .find(|turn| turn.turn_id == work.origin.turn_id)
        .is_none_or(|turn| turn.original_message_id != work.origin.message_id)
    {
        return Err(invalid("project_work_legacy_origin_message_invalid"));
    }
    let source_identity = if prior.is_some() {
        format!("r2:{source_program_id}:{}", row.work_id)
    } else {
        format!("current-r3:{}", row.work_id)
    };
    let semantic = json!({
        "sourceProgramId":source_program_id,"sourceIdentity":source_identity,"work":work,
        "plans":plans,"checkpoints":checkpoints,"reviews":reviews,
        "dispositions":dispositions,"bindings":bindings,"turns":turns,
    });
    let source_sha256 = source_hash(&semantic)?;
    Ok(Some(ProjectWorkLegacySnapshot {
        source_kind: ProjectWorkLegacySourceKind::SqliteR3,
        source_program_ids: vec![source_program_id.clone()],
        source_program_id,
        source_identity,
        source_sha256,
        work,
        plans,
        checkpoints,
        reviews,
        dispositions,
        bindings,
        turns,
    }))
}

pub(super) fn bindings(
    db: &Connection,
    work_id: &str,
    session_id: &str,
) -> StorageResult<Vec<ProjectWorkBinding>> {
    let mut query = db.prepare(
        "SELECT binding_revision_id,turn_id,revision,is_current,bound_at,session_id \
         FROM btcc_guided_turn_work_bindings WHERE work_id=?1 ORDER BY revision,binding_revision_id",
    ).map_err(StorageError::sqlite)?;
    query
        .query_map([work_id], |row| {
            Ok((
                ProjectWorkBinding {
                    binding_revision_id: row.get(0)?,
                    turn_id: row.get(1)?,
                    revision: row.get(2)?,
                    is_current: row.get::<_, i64>(3)? == 1,
                    bound_at: row.get(4)?,
                },
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .map(|row| {
            let (binding, session) = row.map_err(StorageError::sqlite)?;
            if session != session_id {
                return Err(invalid("project_work_legacy_binding_session_mismatch"));
            }
            if !binding.is_current {
                return Err(invalid("project_work_legacy_stale_binding_invalid"));
            }
            Ok(binding)
        })
        .collect()
}

pub(super) fn turns(
    db: &Connection,
    ids: &[String],
    session_id: &str,
) -> StorageResult<Vec<ProjectWorkLegacyTurn>> {
    ids.iter().map(|id| {
        let row = db.query_row(
            "SELECT turn_id,session_id,original_message_id,original_message,semantic_state,execution_fence \
             FROM btcc_turns WHERE turn_id=?1",
            [id], |row| Ok(ProjectWorkLegacyTurn {
                turn_id: row.get(0)?, session_id: row.get(1)?, original_message_id: row.get(2)?,
                original_message: row.get(3)?, semantic_state: row.get(4)?, execution_fence: row.get(5)?,
            }),
        ).optional().map_err(StorageError::sqlite)?;
        row.filter(|turn| turn.session_id == session_id)
            .ok_or_else(|| invalid("project_work_legacy_turn_ownership_invalid"))
    }).collect()
}

fn required_turn_ids(
    db: &Connection,
    work: &crate::btcc::work::WorkView,
    bindings: &[ProjectWorkBinding],
) -> StorageResult<Vec<String>> {
    let mut ids = Vec::new();
    let mut push = |id: &str| {
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    };
    push(&work.origin.turn_id);
    for table in [
        "btcc_guided_work_plan_revisions",
        "btcc_guided_work_checkpoint_revisions",
        "btcc_guided_work_review_revisions",
        "btcc_guided_work_disposition_revisions",
    ] {
        let sql = format!("SELECT origin_turn_id FROM {table} WHERE work_id=?1");
        let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
        let rows = statement
            .query_map([&work.work_id], |row| row.get::<_, String>(0))
            .map_err(StorageError::sqlite)?;
        for row in rows {
            push(&row.map_err(StorageError::sqlite)?);
        }
    }
    for result in &work.result_refs {
        push(&result.origin_turn_id);
    }
    for binding in bindings {
        push(&binding.turn_id);
    }
    Ok(ids)
}
