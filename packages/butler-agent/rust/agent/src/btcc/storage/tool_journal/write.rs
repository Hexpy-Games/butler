use rusqlite::{Connection, OptionalExtension, params};

use super::{ToolJournalFinish, ToolJournalStart};
use crate::btcc::StorageCode;
use crate::btcc::identity::digest;
use crate::btcc::storage::common::{canonical_json, error, json, stringify};
use crate::btcc::storage::{StorageError, StorageResult};

pub(super) fn start(
    db: &Connection,
    input: &ToolJournalStart,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    let arguments_json = canonical_json(&input.arguments)?;
    let started_at = clock();
    db.execute(
        "INSERT OR IGNORE INTO btcc_guided_tool_calls
        (call_id,turn_id,tool_name,raw_arguments,arguments_json,turn_sequence,status,started_at)
        SELECT ?1,?2,?3,?4,?5,COALESCE(MAX(turn_sequence),0)+1,'started',?6
        FROM btcc_guided_tool_calls WHERE turn_id=?2",
        params![
            input.call_id,
            input.turn_id,
            input.tool_name,
            input.raw_arguments,
            arguments_json,
            started_at
        ],
    )
    .map_err(StorageError::sqlite)?;
    let current = db
        .query_row(
            "SELECT turn_id,tool_name,arguments_json FROM btcc_guided_tool_calls WHERE call_id=?1",
            [&input.call_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if let Some((turn_id, tool_name, stored)) = current {
        let stored = canonical_json(&json(&stored, StorageCode::ToolJournalJsonInvalid)?)?;
        if turn_id == input.turn_id && tool_name == input.tool_name && stored == arguments_json {
            return Ok(());
        }
    }
    Err(error(
        StorageCode::GuidedToolCallIdentityConflict,
        "Guided tool call identity conflict",
    ))
}

pub(super) fn finish(
    db: &Connection,
    input: ToolJournalFinish,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    let result_json = input.result.as_ref().map(crate::json::JsonDocument::as_str);
    let result_sha256 = result_json.map(digest);
    let changed_files_json = input
        .changed_files
        .filter(|files| !files.is_empty())
        .map(serde_json::Value::Array)
        .as_ref()
        .map(stringify)
        .transpose()?;
    let finished_at = clock();
    let updated = db
        .execute(
            "UPDATE btcc_guided_tool_calls SET status=?1,result_json=?2,result_sha256=?3,
        changed_files_json=?4,error_code=?5,finished_at=?6
        WHERE call_id=?7 AND status IN ('started','awaiting_authority')",
            params![
                input.status.as_str(),
                result_json,
                result_sha256,
                changed_files_json,
                input.error_code,
                finished_at,
                input.call_id
            ],
        )
        .map_err(StorageError::sqlite)?;
    if updated == 1 {
        return Ok(());
    }
    let current = db.query_row(
        "SELECT status,result_json,changed_files_json,error_code FROM btcc_guided_tool_calls WHERE call_id=?1",
        [&input.call_id],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, Option<String>>(1)?,row.get::<_, Option<String>>(2)?,row.get::<_, Option<String>>(3)?)),
    ).optional().map_err(StorageError::sqlite)?;
    if let Some((status, result, files, error_code)) = current
        && status == input.status.as_str()
        && result.as_deref() == result_json
        && files == changed_files_json
        && error_code == input.error_code
    {
        return Ok(());
    }
    Err(error(
        StorageCode::GuidedToolResultIdentityConflict,
        "Guided tool result identity conflict",
    ))
}
