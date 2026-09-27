//! Locate a projected Project Work without holding the SQL actor while its
//! canonical Ledger authority is prepared.

use rusqlite::{Connection, OptionalExtension, params};

use super::super::{StorageError, StorageResult};
use super::contracts::{
    ExactResultRangeInput, OperationResultReferenceInput, ProjectWorkResultAuthorityLocation,
};
use super::query;
use crate::btcc::StorageCode;

struct ProjectedWork {
    work_id: String,
    scope_kind: String,
    scope_ref: String,
    ledger_project_id: Option<String>,
    canonical_head_sha256: Option<String>,
}

impl ProjectedWork {
    fn location(self) -> Option<ProjectWorkResultAuthorityLocation> {
        if !query::managed_fields(
            &self.scope_kind,
            self.ledger_project_id.as_deref(),
            self.canonical_head_sha256.as_deref(),
        ) {
            return None;
        }
        Some(ProjectWorkResultAuthorityLocation {
            work_id: self.work_id,
            app_project_id: self.scope_ref,
            ledger_project_id: self.ledger_project_id?,
        })
    }
}

const RESULT_WORK: &str = "SELECT work.work_id, work.scope_kind, work.scope_ref,
  work.ledger_project_id, work.canonical_head_sha256
FROM btcc_guided_work_results result
JOIN btcc_guided_works work ON work.work_id = result.work_id";

fn projected(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectedWork> {
    Ok(ProjectedWork {
        work_id: row.get(0)?,
        scope_kind: row.get(1)?,
        scope_ref: row.get(2)?,
        ledger_project_id: row.get(3)?,
        canonical_head_sha256: row.get(4)?,
    })
}

fn by_result_ref(db: &Connection, result_ref: &str) -> StorageResult<Option<ProjectedWork>> {
    db.query_row(
        &format!("{RESULT_WORK} WHERE result.result_ref = ?1 LIMIT 1"),
        [result_ref],
        projected,
    )
    .optional()
    .map_err(StorageError::sqlite)
}

fn by_call(db: &Connection, turn_id: &str, call_id: &str) -> StorageResult<Option<ProjectedWork>> {
    db.query_row(
        &format!(
            "{RESULT_WORK} WHERE result.origin_turn_id = ?1 AND result.tool_call_id = ?2 LIMIT 1"
        ),
        params![turn_id, call_id],
        projected,
    )
    .optional()
    .map_err(StorageError::sqlite)
}

fn current_binding(db: &Connection, turn_id: &str) -> StorageResult<Option<ProjectedWork>> {
    let mut query = db
        .prepare(
            "SELECT work.work_id, work.scope_kind, work.scope_ref,
          work.ledger_project_id, work.canonical_head_sha256
         FROM btcc_guided_turn_work_bindings binding
         JOIN btcc_guided_works work ON work.work_id = binding.work_id
         WHERE binding.turn_id = ?1 AND binding.is_current = 1
         ORDER BY binding.revision DESC LIMIT 2",
        )
        .map_err(StorageError::sqlite)?;
    let mut rows = query
        .query_map([turn_id], projected)
        .map_err(StorageError::sqlite)?;
    let first = rows.next().transpose().map_err(StorageError::sqlite)?;
    if rows
        .next()
        .transpose()
        .map_err(StorageError::sqlite)?
        .is_some()
    {
        return Err(StorageError::new(
            StorageCode::WorkScopeTurnBindingAmbiguous,
            "Work Turn binding is ambiguous",
        ));
    }
    Ok(first)
}

pub(super) fn for_reference(
    db: &Connection,
    input: &OperationResultReferenceInput,
) -> StorageResult<Option<ProjectWorkResultAuthorityLocation>> {
    if let Some(work) = by_call(db, &input.turn_id, &input.call_id)? {
        return Ok(work.location());
    }
    Ok(current_binding(db, &input.turn_id)?.and_then(ProjectedWork::location))
}

pub(super) fn for_range(
    db: &Connection,
    input: &ExactResultRangeInput,
) -> StorageResult<Option<ProjectWorkResultAuthorityLocation>> {
    if let Some(work) = by_result_ref(db, &input.result_ref)? {
        return Ok(work.location());
    }
    Ok(current_binding(db, &input.turn_id)?.and_then(ProjectedWork::location))
}
