use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::super::{StorageError, StorageResult, common};

pub(super) fn normalize_list(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && seen.insert((*value).to_owned()))
        .map(str::to_owned)
        .collect()
}

pub(super) fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(in crate::btcc::storage) fn resolve(
    db: &Connection,
    work_id: &str,
    turn_id: &str,
    refs: &[String],
) -> StorageResult<Vec<String>> {
    if refs.is_empty() {
        return db.prepare("SELECT result.result_ref FROM btcc_guided_work_results result JOIN btcc_guided_tool_calls calls ON calls.call_id = result.tool_call_id WHERE result.work_id = ?1 AND result.origin_turn_id = ?2 AND calls.status = 'completed' ORDER BY result.sequence ASC")
            .map_err(StorageError::sqlite)?.query_map(params![work_id, turn_id], |row| row.get::<_, String>(0)).map_err(StorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite);
    }
    let mut snapshot = Vec::with_capacity(refs.len());
    for reference in refs {
        let result: Option<(String, String)> = db.query_row("SELECT result.result_ref, calls.status FROM btcc_guided_work_results result JOIN btcc_guided_tool_calls calls ON calls.call_id = result.tool_call_id WHERE result.work_id = ?1 AND result.origin_turn_id = ?2 AND (result.result_ref = ?3 OR result.tool_call_id = ?3)", params![work_id, turn_id, reference], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(StorageError::sqlite)?;
        if let Some((result_ref, status)) = result
            && status == "completed"
        {
            snapshot.push(result_ref);
            continue;
        }
        let current: Option<String> = db
            .query_row(
                "SELECT status FROM btcc_guided_tool_calls WHERE turn_id = ?1 AND call_id = ?2",
                params![turn_id, reference],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::sqlite)?;
        if current.as_deref() == Some("completed") {
            let attached: Option<(String, String, String)> = db.query_row("SELECT result_ref, work_id, origin_turn_id FROM btcc_guided_work_results WHERE tool_call_id = ?1", [reference], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(StorageError::sqlite)?;
            if let Some((result_ref, attached_work, attached_turn)) = attached
                && attached_work == work_id
                && attached_turn == turn_id
            {
                snapshot.push(result_ref);
                continue;
            }
        }
        let mut statement = db
            .prepare(
                "SELECT work_id, status, receipt_id FROM btcc_guided_effects WHERE receipt_id = ?1",
            )
            .map_err(StorageError::sqlite)?;
        let effects = statement
            .query_map([reference], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(StorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::sqlite)?;
        if effects.len() > 1 {
            return Err(common::error(
                "durable_work_evidence_ambiguous",
                format!("Durable Work evidence reference is ambiguous: {reference}"),
            ));
        }
        if let Some((effect_work, status, receipt)) = effects.into_iter().next()
            && effect_work == work_id
            && status == "applied"
        {
            snapshot.push(receipt);
            continue;
        }
        return Err(common::error(
            "durable_work_evidence_ineligible",
            format!("Durable Work evidence reference is not eligible: {reference}"),
        ));
    }
    Ok(snapshot)
}
