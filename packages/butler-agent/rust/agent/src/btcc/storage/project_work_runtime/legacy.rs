mod current;
mod observe;
mod raw;

use rusqlite::{Connection, OptionalExtension};

use crate::btcc::work::{
    ProjectWorkLegacyInput, ProjectWorkLegacyObservation, ProjectWorkLegacyObserveInput,
    ProjectWorkLegacySnapshot,
};

use super::super::{StorageError, StorageResult};
use super::SqliteProjectWorkRuntime;

fn invalid(code: &'static str) -> StorageError {
    StorageError::new(code, code)
}

pub(super) fn import_observation(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
) -> StorageResult<Option<ProjectWorkLegacyObservation>> {
    require_turn(db, &input.scope)?;
    let rows = current::locate(db, input)?;
    if rows.len() > 1 {
        return Err(invalid("project_work_legacy_multiple_open_works"));
    }
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    if row.ledger_project_id.as_deref().is_none_or(str::is_empty)
        || row
            .canonical_head_sha256
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Ok(None);
    }
    let Some(prior) = current::import_row(db, &row.work_id)? else {
        return Ok(None);
    };
    if current::has_semantic_rows(db, &row.work_id)? {
        return Ok(None);
    }
    if row.ledger_project_id.as_deref() != Some(input.resolved_scope.ledger_project_id.as_str())
        || !valid_hash(row.canonical_head_sha256.as_deref().unwrap_or(""))
        || !valid_hash(&prior.source_revision)
        || prior.session_id != input.scope.session_id
        || prior.scope_kind != "project"
        || prior.scope_ref != input.resolved_scope.app_project_id
        || prior.source_authority != "project_ledger"
        || prior.work_id != row.work_id
    {
        return Err(invalid("project_work_legacy_observation_invalid"));
    }
    current::preflight(
        db,
        input,
        &row.work_id,
        &prior.legacy_program_id,
        Some(&prior),
    )?;
    Ok(Some(ProjectWorkLegacyObservation {
        source_program_id: prior.legacy_program_id,
        source_sha256: prior.source_revision,
        work_id: row.work_id.clone(),
    }))
}

pub(super) fn capture_sqlite(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
) -> StorageResult<Option<ProjectWorkLegacySnapshot>> {
    require_turn(db, &input.scope)?;
    current::capture(db, input)
}

pub(super) async fn capture_raw_r2(
    runtime: &SqliteProjectWorkRuntime,
    input: &ProjectWorkLegacyInput,
) -> Result<Option<ProjectWorkLegacySnapshot>, crate::btcc::BtccError> {
    raw::capture(runtime, input).await
}

pub(super) async fn revalidate(
    runtime: &SqliteProjectWorkRuntime,
    input: ProjectWorkLegacyInput,
    snapshot: std::sync::Arc<ProjectWorkLegacySnapshot>,
) -> Result<(), crate::btcc::BtccError> {
    raw::revalidate(runtime, input, snapshot).await
}

pub(super) fn observe_imported(
    db: &Connection,
    input: &ProjectWorkLegacyObserveInput,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    observe::apply(db, input, clock)
}

fn require_turn(db: &Connection, scope: &crate::btcc::work::WorkTurnScope) -> StorageResult<()> {
    let row = db
        .query_row(
            "SELECT session_id FROM btcc_turns WHERE turn_id=?1",
            [&scope.turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if row.as_deref() != Some(scope.session_id.as_str()) {
        return Err(invalid("project_work_legacy_turn_ownership_invalid"));
    }
    Ok(())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn record_id(kind: &str, identity: &str) -> String {
    format!(
        "guided-{kind}-{}",
        crate::btcc::identity::digest(&format!("btcc-guided-work.v1\0{kind}\0{identity}"))
    )
}

fn import_id(program: &str, session: &str, app_project: &str) -> String {
    record_id(
        "legacy-import",
        &format!("{program}\0{session}\0{app_project}"),
    )
}

fn source_hash<T: serde::Serialize>(value: &T) -> StorageResult<String> {
    let json =
        serde_json::to_value(value).map_err(|_| invalid("project_work_legacy_source_invalid"))?;
    Ok(crate::btcc::identity::digest(
        &crate::btcc::identity::sqlite_stable_json(&json)
            .map_err(|_| invalid("project_work_legacy_source_invalid"))?,
    ))
}
