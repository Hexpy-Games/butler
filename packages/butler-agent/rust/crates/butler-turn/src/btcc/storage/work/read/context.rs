use rusqlite::{Connection, OptionalExtension};

use crate::btcc::work::{OriginalRequest, WorkContext, WorkResultFact};

use super::super::{StorageError, StorageResult, common};
use crate::btcc::StorageCode;

/// Reverse the entire source tuple, cap in SQLite, then restore ascending order.
const TAIL_ORDER: &str = "CASE WHEN result.source_turn_rowid IS NULL THEN 1 ELSE 0 END DESC, result.source_turn_rowid DESC, CASE WHEN result.source_turn_sequence IS NULL THEN 1 ELSE 0 END DESC, result.source_turn_sequence DESC, result.sequence DESC, result.rowid DESC";

pub(super) fn hydrate(db: &Connection, row: &common::WorkRow) -> StorageResult<WorkContext> {
    let origin = db
        .query_row(
            "SELECT turn_id, session_id, original_message_id, original_message \
             FROM btcc_turns WHERE turn_id = ?1",
            [&row.origin_turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((turn_id, _session_id, message_id, content)) = origin else {
        return Err(common::error(
            StorageCode::DurableWorkOriginalRequestUnavailable,
            format!("Durable Work original request is unavailable: {}", row.id),
        ));
    };
    if message_id != row.origin_message_id {
        return Err(common::error(
            StorageCode::DurableWorkOriginalRequestUnavailable,
            format!("Durable Work original request is unavailable: {}", row.id),
        ));
    }
    let sql = format!(
        "SELECT result.result_ref, call.tool_name, call.status, call.result_json, call.error_code \
         FROM btcc_guided_work_results result \
         JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id \
         WHERE result.work_id = ?1 ORDER BY {TAIL_ORDER} LIMIT 50"
    );
    let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
    let mut facts = statement
        .query_map([&row.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    facts.reverse();
    let result_facts = facts
        .into_iter()
        .map(|(reference, tool_name, status, json, error_code)| {
            Ok(WorkResultFact {
                result_ref: Some(reference),
                tool_name,
                status,
                result_json: json.map(|body| common::parse_json(&body)).transpose()?,
                error_code: error_code.filter(|code| !code.is_empty()),
            })
        })
        .collect::<StorageResult<Vec<_>>>()?;
    Ok(WorkContext {
        work: super::view::hydrate(db, row)?,
        original_request: OriginalRequest {
            turn_id,
            message_id,
            content,
        },
        result_facts,
    })
}
