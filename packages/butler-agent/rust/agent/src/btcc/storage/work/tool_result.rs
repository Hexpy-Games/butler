use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::WorkTurnScope;

use super::{StorageError, StorageResult, common};

pub(in crate::btcc::storage) const CONTROL_TOOLS: &[&str] = &[
    "start_work",
    "continue_work",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
];

pub(super) fn backfill(
    db: &Connection,
    work_id: &str,
    scope: &WorkTurnScope,
    _mutation_id: &str,
    calls: &[String],
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    if calls.is_empty() {
        return Ok(());
    }
    common::relation_turn(db, scope)?;
    for call_id in calls {
        attach(db, work_id, &scope.turn_id, call_id, clock)?;
    }
    Ok(())
}

pub(super) fn attach(
    db: &Connection,
    work_id: &str,
    turn_id: &str,
    call_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<String> {
    let call = db.query_row("SELECT call.turn_id, call.tool_name, call.status, turn.rowid, call.turn_sequence FROM btcc_guided_tool_calls call LEFT JOIN btcc_turns turn ON turn.turn_id = call.turn_id WHERE call.call_id = ?1", [call_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<i64>>(4)?)))
        .optional().map_err(StorageError::sqlite)?;
    let Some((source_turn, tool_name, status, source_turn_rowid, source_turn_sequence)) = call
    else {
        return Err(common::error(
            "durable_work_tool_not_committed",
            format!("Durable Work tool result is not committed: {call_id}"),
        ));
    };
    if source_turn != turn_id || status == "started" {
        return Err(common::error(
            "durable_work_tool_not_committed",
            format!("Durable Work tool result is not committed: {call_id}"),
        ));
    }
    if status != "completed" {
        return Err(common::error(
            "durable_work_tool_ineligible",
            format!("Durable Work tool result is not eligible for attachment: {call_id}"),
        ));
    }
    if CONTROL_TOOLS.contains(&tool_name.as_str()) {
        return Err(common::error(
            "durable_work_control_result",
            format!("Durable Work control result cannot be attached: {tool_name}"),
        ));
    }
    let existing = db
        .query_row(
            "SELECT result_ref, work_id FROM btcc_guided_work_results WHERE tool_call_id = ?1",
            [call_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if existing
        .as_ref()
        .is_some_and(|(_, existing_work)| existing_work != work_id)
    {
        return Err(common::error(
            "durable_work_result_other",
            "Durable Work tool result is already bound to another Work",
        ));
    }
    if let Some((reference, _)) = existing {
        return Ok(reference);
    }
    let reference = common::record_id("result", call_id);
    let sequence = common::latest_result_sequence(db, work_id)? + 1;
    db.execute("INSERT INTO btcc_guided_work_results (result_ref, work_id, sequence, tool_call_id, origin_turn_id, source_turn_rowid, source_turn_sequence, attached_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![reference, work_id, sequence, call_id, turn_id, source_turn_rowid, source_turn_sequence, clock()]).map_err(StorageError::sqlite)?;
    Ok(reference)
}
