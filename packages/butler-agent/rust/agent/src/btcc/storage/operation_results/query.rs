use base64::Engine;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::super::{StorageError, StorageResult};
use super::contracts::*;
use crate::btcc::StorageCode;

const OUTCOME: &str = r"CASE
  WHEN c.status IN ('cancelled', 'failed') THEN c.status
  WHEN json_type(c.result_json) = 'object' AND (
    json_type(c.result_json, '$.ok') = 'false'
    OR json_type(c.result_json, '$.timed_out') = 'true'
    OR (
      json_type(c.result_json, '$.exit_code') IN ('integer', 'real')
      AND json_extract(c.result_json, '$.exit_code') != 0
    )
  ) THEN 'failed'
  ELSE c.status
END";

const THROUGH_SQL: &str = r"SELECT COALESCE(MAX(c.rowid), 0)
FROM btcc_guided_tool_calls c
WHERE c.turn_id = ?1
  OR EXISTS (
    SELECT 1 FROM btcc_guided_work_results work_result
    WHERE work_result.tool_call_id = c.call_id
      AND work_result.work_id = ?2
  )";

pub(super) fn discover(
    db: &Connection,
    input: &OperationResultDiscoveryInput,
) -> StorageResult<OperationResultDiscovery> {
    let work = input.work_id.as_deref().unwrap_or("");
    let through = input.through.map(Ok).unwrap_or_else(|| {
        db.query_row(THROUGH_SQL, params![input.turn_id, work], |row| {
            row.get::<_, f64>(0)
        })
        .map_err(StorageError::sqlite)
    })?;
    let sql = format!(
        r"SELECT call_id, turn_id, c.rowid, tool_name, {OUTCOME}, started_at,
  substr(arguments_json, 1, 240), result_sha256
FROM btcc_guided_tool_calls c
WHERE (
    c.turn_id = ?1
    OR EXISTS (
      SELECT 1 FROM btcc_guided_work_results work_result
      WHERE work_result.tool_call_id = c.call_id
        AND work_result.work_id = ?2
    )
  )
  AND c.rowid > ?3
  AND c.rowid <= ?4
  AND result_json IS NOT NULL
  AND result_sha256 IS NOT NULL
  AND tool_name NOT IN ('list_operation_results', 'read_operation_results')
  AND (?5 = '' OR tool_name = ?6)
  AND (?7 = '' OR {OUTCOME} = ?8)
  AND (?9 = '' OR instr(lower(arguments_json), lower(?10)) > 0)
ORDER BY c.rowid
LIMIT ?11"
    );
    let tool = input.tool_name.as_deref().unwrap_or("");
    let status = input.status.as_deref().unwrap_or("");
    let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
    let mut entries = statement
        .query_map(
            params![
                input.turn_id,
                work,
                input.cursor,
                through,
                tool,
                tool,
                status,
                status,
                input.query,
                input.query,
                input.limit + 1.0
            ],
            |row| {
                Ok(OperationResultDiscoveryEntry {
                    call_id: row.get(0)?,
                    origin_turn_id: row.get(1)?,
                    ordinal: row.get(2)?,
                    tool_name: row.get(3)?,
                    status: row.get(4)?,
                    started_at: row.get(5)?,
                    request_preview: row.get(6)?,
                    result_sha256: row.get(7)?,
                })
            },
        )
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    let limit = crate::json::saturating_usize(input.limit.max(0.0));
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| entries.last().map(|entry| entry.ordinal))
        .flatten();
    Ok(OperationResultDiscovery {
        entries,
        through,
        next_cursor,
    })
}

#[derive(Clone)]
struct Work {
    call_id: String,
    tool_name: String,
    status: String,
    result_sha256: Option<String>,
    error_code: Option<String>,
    result_ref: String,
    sequence: f64,
    work_id: String,
    origin_turn_id: String,
    session_id: String,
    scope_kind: String,
    scope_ref: String,
    ledger_project_id: Option<String>,
    canonical_head_sha256: Option<String>,
}

const WORK_FIELDS: &str = r"SELECT
  call.call_id,
  call.tool_name,
  call.status,
  call.result_sha256,
  call.error_code,
  result.result_ref,
  result.sequence,
  result.work_id,
  result.origin_turn_id,
  work.session_id,
  work.scope_kind,
  work.scope_ref,
  work.ledger_project_id,
  work.canonical_head_sha256
FROM btcc_guided_work_results result
JOIN btcc_guided_works work ON work.work_id = result.work_id
JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id";

fn map_work(row: &rusqlite::Row<'_>) -> rusqlite::Result<Work> {
    Ok(Work {
        call_id: row.get(0)?,
        tool_name: row.get(1)?,
        status: row.get(2)?,
        result_sha256: row.get(3)?,
        error_code: row.get(4)?,
        result_ref: row.get(5)?,
        sequence: row.get(6)?,
        work_id: row.get(7)?,
        origin_turn_id: row.get(8)?,
        session_id: row.get(9)?,
        scope_kind: row.get(10)?,
        scope_ref: row.get(11)?,
        ledger_project_id: row.get(12)?,
        canonical_head_sha256: row.get(13)?,
    })
}

fn work(db: &Connection, suffix: &str, value: &str) -> StorageResult<Option<Work>> {
    let sql = format!("{WORK_FIELDS} WHERE {suffix} LIMIT 1");
    db.query_row(&sql, [value], map_work)
        .optional()
        .map_err(StorageError::sqlite)
}
fn work_call(
    db: &Connection,
    input: &OperationResultReferenceInput,
) -> StorageResult<Option<Work>> {
    let sql =
        format!("{WORK_FIELDS} WHERE result.origin_turn_id=?1 AND result.tool_call_id=?2 LIMIT 1");
    db.query_row(&sql, params![input.turn_id, input.call_id], map_work)
        .optional()
        .map_err(StorageError::sqlite)
}
fn managed(work: &Work) -> bool {
    managed_fields(
        &work.scope_kind,
        work.ledger_project_id.as_deref(),
        work.canonical_head_sha256.as_deref(),
    )
}

pub(super) fn managed_fields(
    scope_kind: &str,
    ledger_project_id: Option<&str>,
    canonical_head_sha256: Option<&str>,
) -> bool {
    scope_kind == "project"
        && ledger_project_id.is_some_and(|v| !crate::public_text::trim_js_whitespace(v).is_empty())
        && canonical_head_sha256.is_some_and(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn verify(
    authority: Option<&dyn ExactProjectWorkResultAuthority>,
    work: &Work,
    hash: &str,
) -> StorageResult<()> {
    let authority =
        authority.ok_or_else(|| error(StorageCode::OperationResultProjectAuthorityMissing))?;
    let canonical = authority.verify(&ExactProjectWorkResultVerification {
        result_ref: work.result_ref.clone(),
        revision: work.sequence,
        work_id: work.work_id.clone(),
        session_id: work.session_id.clone(),
        scope_ref: work.scope_ref.clone(),
        ledger_project_id: work.ledger_project_id.clone().unwrap_or_default(),
        tool_call_id: work.call_id.clone(),
        turn_id: work.origin_turn_id.clone(),
        result_sha256: hash.into(),
    })?;
    if canonical.tool_name != work.tool_name
        || work.result_sha256.as_deref() != Some(&canonical.result_sha256)
        || work.status != "completed"
        || work.error_code.is_some()
    {
        return Err(error(StorageCode::OperationResultProjectReferenceMismatch));
    }
    Ok(())
}

pub(super) fn resolve(
    db: &Connection,
    authority: Option<&dyn ExactProjectWorkResultAuthority>,
    input: &OperationResultReferenceInput,
) -> StorageResult<OperationResultReference> {
    if let Some(canonical) = authority
        .map(|authority| authority.resolve(input))
        .transpose()?
        .flatten()
    {
        let work = work(db, "result.result_ref=?1", &canonical.result_ref)?
            .ok_or_else(|| error(StorageCode::OperationResultProjectProjectionMismatch))?;
        verify(authority, &work, &canonical.result_sha256)?;
        return Ok(OperationResultReference {
            kind: "work",
            result_ref: canonical.result_ref,
            revision: Some(canonical.revision),
            work_id: Some(canonical.work_id),
            session_id: Some(canonical.session_id),
            scope_kind: Some("project".into()),
            scope_ref: Some(canonical.scope_ref),
        });
    }
    if let Some(work) = work_call(db, input)? {
        if managed(&work) {
            return Err(error(if authority.is_none() {
                StorageCode::OperationResultProjectAuthorityMissing
            } else {
                StorageCode::OperationResultProjectReferenceMismatch
            }));
        }
        return Ok(OperationResultReference {
            kind: "work",
            result_ref: work.result_ref,
            revision: Some(work.sequence),
            work_id: Some(work.work_id),
            session_id: Some(work.session_id),
            scope_kind: Some(work.scope_kind),
            scope_ref: Some(work.scope_ref),
        });
    }
    Ok(OperationResultReference {
        kind: "direct",
        result_ref: input.call_id.clone(),
        revision: None,
        work_id: None,
        session_id: None,
        scope_kind: None,
        scope_ref: None,
    })
}

struct Payload {
    tool: String,
    raw: String,
    result: Option<String>,
    hash: Option<String>,
}

const PAYLOAD_SQL: &str = r"SELECT
  tool_name,
  raw_arguments,
  result_json,
  result_sha256
FROM btcc_guided_tool_calls
WHERE turn_id = ?1 AND call_id = ?2";

fn payload(db: &Connection, turn: &str, call: &str) -> StorageResult<Option<Payload>> {
    db.query_row(PAYLOAD_SQL, params![turn, call], |row| {
        Ok(Payload {
            tool: row.get(0)?,
            raw: row.get(1)?,
            result: row.get(2)?,
            hash: row.get(3)?,
        })
    })
    .optional()
    .map_err(StorageError::sqlite)
}
pub(super) fn read_exact(
    db: &Connection,
    authority: Option<&dyn ExactProjectWorkResultAuthority>,
    input: &ExactResultRangeInput,
) -> StorageResult<ExactResultRange> {
    let payload = if let Some(work) = work(db, "result.result_ref=?1", &input.result_ref)? {
        if input.revision != Some(work.sequence) {
            return Err(error(StorageCode::OperationResultRevisionMismatch));
        }
        if input.work_id.as_deref() != Some(&work.work_id) {
            return Err(error(StorageCode::OperationResultWorkMismatch));
        }
        if input.session_id.as_deref() != Some(&work.session_id) {
            return Err(error(StorageCode::OperationResultSessionMismatch));
        }
        if (work.scope_kind == "session"
            && (input.session_id.as_deref() != Some(&work.scope_ref)
                || input.project_ref.is_some()))
            || (work.scope_kind == "project"
                && input.project_ref.as_deref() != Some(&work.scope_ref))
        {
            return Err(error(StorageCode::OperationResultScopeMismatch));
        }
        if managed(&work) {
            verify(authority, &work, &input.result_sha256)?;
        }
        let payload = payload(db, &work.origin_turn_id, &work.call_id)?
            .ok_or_else(|| error(StorageCode::OperationResultMissingOrScopeMismatch))?;
        if payload.tool != work.tool_name {
            return Err(error(StorageCode::OperationResultProjectReferenceMismatch));
        }
        payload
    } else {
        if input
            .project_ref
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            && authority
                .map(|authority| {
                    authority.resolve(&OperationResultReferenceInput {
                        turn_id: input.turn_id.clone(),
                        call_id: input.result_ref.clone(),
                    })
                })
                .transpose()?
                .flatten()
                .is_some()
        {
            return Err(error(StorageCode::OperationResultProjectProjectionMismatch));
        }
        let payload = payload(db, &input.turn_id, &input.result_ref)?
            .ok_or_else(|| error(StorageCode::OperationResultMissingOrScopeMismatch))?;
        if input.revision.is_some() {
            return Err(error(StorageCode::OperationResultRevisionMismatch));
        }
        payload
    };
    let result = payload
        .result
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(StorageCode::OperationResultBodyHashMismatch))?;
    let hash = payload
        .hash
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(StorageCode::OperationResultBodyHashMismatch))?;
    let actual = format!("{:x}", Sha256::digest(result.as_bytes()));
    if actual != hash {
        return Err(error(StorageCode::OperationResultBodyHashMismatch));
    }
    if hash != input.result_sha256 {
        return Err(error(StorageCode::OperationResultIntegrityMismatch));
    }
    let bytes = match input.source {
        ExactResultSource::Request => payload.raw.as_bytes(),
        ExactResultSource::Result => result.as_bytes(),
    };
    if input.offset >= bytes.len() {
        return Err(error(StorageCode::OperationResultRangeOutOfBounds));
    }
    let end = input.offset.saturating_add(input.length).min(bytes.len());
    Ok(ExactResultRange {
        encoding: "base64",
        data: base64::engine::general_purpose::STANDARD.encode(&bytes[input.offset..end]),
        offset: input.offset,
        length: end - input.offset,
        total_bytes: bytes.len(),
        next_offset: (end < bytes.len()).then_some(end),
        result_sha256: hash.to_owned(),
        complete: input.offset == 0 && end == bytes.len(),
    })
}
