use rusqlite::{Connection, OptionalExtension, Row};

use super::{ToolJournalCloseoutRow, ToolJournalRecord, ToolJournalSignature};
use crate::btcc::identity::digest;
use crate::btcc::storage::common::{error, json};
use crate::btcc::storage::{StorageError, StorageResult};

const FIELDS: &str = "call_id,tool_name,raw_arguments,arguments_json,status,result_json,
    result_sha256,changed_files_json,error_code,delivery_state,delivery_round_id,delivery_response_sha256";

struct StoredRecord {
    ordinal: Option<f64>,
    call_id: String,
    tool_name: String,
    raw_arguments: String,
    arguments_json: String,
    status: String,
    result_json: Option<String>,
    result_sha256: Option<String>,
    changed_files_json: Option<String>,
    error_code: Option<String>,
    delivery_state: Option<String>,
    delivery_round_id: Option<String>,
    delivery_response_sha256: Option<String>,
}

pub(super) fn find(
    db: &Connection,
    turn_id: &str,
    call_id: &str,
) -> StorageResult<Option<ToolJournalRecord>> {
    let row = db
        .query_row(
            &format!("SELECT {FIELDS} FROM btcc_guided_tool_calls WHERE call_id=?1 AND turn_id=?2"),
            [call_id, turn_id],
            |row| stored(row, false),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    row.map(hydrate).transpose()
}

pub(super) fn restart_requests(
    db: &Connection,
    turn_id: &str,
) -> StorageResult<Vec<ToolJournalRecord>> {
    let mut statement = db
        .prepare(
            "SELECT call_id FROM btcc_guided_tool_calls WHERE turn_id=?1 \
         AND tool_name='request_service_restart' AND status='completed' ORDER BY rowid",
        )
        .map_err(StorageError::sqlite)?;
    let ids = statement
        .query_map([turn_id], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)?;
    ids.into_iter()
        .map(|id| {
            find(db, turn_id, &id)?.ok_or_else(|| {
                error(
                    "restart_tool_result_missing",
                    "Restart tool result disappeared",
                )
            })
        })
        .collect()
}

pub(super) fn recent_for_prompt(
    db: &Connection,
    turn_id: &str,
) -> StorageResult<Vec<ToolJournalRecord>> {
    let mut statement = db
        .prepare(
            "SELECT call_id,tool_name,'' AS raw_arguments,arguments_json,status,result_json,
             result_sha256,NULL AS changed_files_json,error_code,NULL AS delivery_state,
             NULL AS delivery_round_id,NULL AS delivery_response_sha256,rowid
             FROM btcc_guided_tool_calls WHERE turn_id=?1 ORDER BY rowid DESC LIMIT 12",
        )
        .map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([turn_id], |row| stored(row, true))
        .map_err(StorageError::sqlite)?;
    rows.map(|row| hydrate(row.map_err(StorageError::sqlite)?))
        .collect()
}

pub(super) fn closeout_page(
    db: &Connection,
    turn_id: &str,
    after_rowid: i64,
    limit: usize,
) -> StorageResult<Vec<ToolJournalCloseoutRow>> {
    let mut statement = db
        .prepare(
            "SELECT rowid,tool_name,status,
            CASE WHEN tool_name='edit_file' THEN arguments_json ELSE '{}' END,
            result_json,result_sha256,changed_files_json
         FROM btcc_guided_tool_calls WHERE turn_id=?1 AND rowid>?2 ORDER BY rowid LIMIT ?3",
        )
        .map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(
            rusqlite::params![
                turn_id,
                after_rowid,
                i64::try_from(limit.min(8)).unwrap_or(i64::MAX)
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(StorageError::sqlite)?;
    rows.map(|row| {
        let (rowid, tool_name, status, arguments, result, result_sha256, changed_files) =
            row.map_err(StorageError::sqlite)?;
        if let Some(raw) = &result
            && result_sha256.as_deref() != Some(digest(raw).as_str())
        {
            return Err(error(
                "operation_result_body_hash_mismatch",
                "operation_result_body_hash_mismatch",
            ));
        }
        let document = |raw| {
            crate::json::JsonDocument::from_encoded(raw)
                .map_err(|error| StorageError::new("tool_journal_json_invalid", error.to_string()))
        };
        Ok(ToolJournalCloseoutRow {
            rowid,
            tool_name,
            status,
            arguments: document(arguments)?,
            result: result.map(document).transpose()?,
            changed_files: changed_files.map(document).transpose()?,
        })
    })
    .collect()
}

pub(super) fn list_signatures(
    db: &Connection,
    turn_id: &str,
) -> StorageResult<Vec<ToolJournalSignature>> {
    let mut statement = db
        .prepare(
            "SELECT call_id,tool_name,raw_arguments,arguments_json
             FROM btcc_guided_tool_calls WHERE turn_id=?1 ORDER BY rowid",
        )
        .map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([turn_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    rows.map(|row| {
        let (call_id, tool_name, raw_arguments, arguments_json) =
            row.map_err(StorageError::sqlite)?;
        Ok(ToolJournalSignature {
            call_id,
            tool_name,
            raw_arguments,
            arguments: json(&arguments_json, "tool_journal_json_invalid")?,
        })
    })
    .collect()
}

pub(super) fn completed_call_identities(
    db: &Connection,
    turn_id: &str,
) -> StorageResult<Vec<(String, String)>> {
    let mut statement = db
        .prepare(
            "SELECT call_id,tool_name FROM btcc_guided_tool_calls
             WHERE turn_id=?1 AND status='completed' ORDER BY rowid",
        )
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([turn_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(StorageError::sqlite)?
        .map(|row| row.map_err(StorageError::sqlite))
        .collect()
}

fn stored(row: &Row<'_>, include_ordinal: bool) -> rusqlite::Result<StoredRecord> {
    Ok(StoredRecord {
        ordinal: if include_ordinal { row.get(12)? } else { None },
        call_id: row.get(0)?,
        tool_name: row.get(1)?,
        raw_arguments: row.get(2)?,
        arguments_json: row.get(3)?,
        status: row.get(4)?,
        result_json: row.get(5)?,
        result_sha256: row.get(6)?,
        changed_files_json: row.get(7)?,
        error_code: row.get(8)?,
        delivery_state: row.get(9)?,
        delivery_round_id: row.get(10)?,
        delivery_response_sha256: row.get(11)?,
    })
}

fn hydrate(row: StoredRecord) -> StorageResult<ToolJournalRecord> {
    if let Some(result) = &row.result_json
        && row.result_sha256.as_deref() != Some(digest(result).as_str())
    {
        return Err(error(
            "operation_result_body_hash_mismatch",
            "operation_result_body_hash_mismatch",
        ));
    }
    let arguments = json(&row.arguments_json, "tool_journal_json_invalid")?;
    let result = row
        .result_json
        .map(|value| {
            crate::json::JsonDocument::from_encoded(value)
                .map_err(|failure| error("tool_journal_json_invalid", failure.to_string()))
        })
        .transpose()?;
    let changed_files = row
        .changed_files_json
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| json(value, "tool_journal_json_invalid"))
        .transpose()?;
    Ok(ToolJournalRecord {
        call_id: row.call_id,
        journal_ordinal: row.ordinal.filter(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && *value > 0.0
                && *value <= 9_007_199_254_740_991.0
        }),
        tool_name: row.tool_name,
        raw_arguments: row.raw_arguments,
        arguments,
        status: row.status,
        result,
        changed_files,
        result_sha256: truthy(row.result_sha256),
        error_code: truthy(row.error_code),
        delivery_state: truthy(row.delivery_state),
        delivery_round_id: truthy(row.delivery_round_id),
        delivery_response_sha256: truthy(row.delivery_response_sha256),
    })
}

fn truthy(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}
