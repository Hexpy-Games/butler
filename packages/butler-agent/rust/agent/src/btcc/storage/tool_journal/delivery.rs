use rusqlite::{Connection, OptionalExtension, params};

use super::read;
use crate::btcc::storage::common::error;
use crate::btcc::storage::{StorageError, StorageResult};

pub(super) fn admit(db: &Connection, turn: &str, call: &str) -> StorageResult<()> {
    validate_id(turn, "operation_result_turn_id_invalid")?;
    validate_id(call, "operation_result_call_id_invalid")?;
    let changed = db
        .execute(
            "UPDATE btcc_guided_tool_calls SET delivery_state='pending_delivery'
        WHERE turn_id=?1 AND call_id=?2 AND status='completed' AND result_json IS NOT NULL
        AND result_sha256 IS NOT NULL AND delivery_state IS NULL",
            [turn, call],
        )
        .map_err(StorageError::sqlite)?;
    if changed == 1 || read::find(db, turn, call)?.is_some_and(|row| row.delivery_state.is_some()) {
        return Ok(());
    }
    fail("operation_result_delivery_admission_failed")
}

pub(super) fn begin(db: &Connection, turn: &str, call: &str, round: &str) -> StorageResult<()> {
    validate_id(turn, "operation_result_turn_id_invalid")?;
    validate_id(call, "operation_result_call_id_invalid")?;
    validate_id(round, "operation_result_round_id_invalid")?;
    let changed = db
        .execute(
            "UPDATE btcc_guided_tool_calls SET delivery_state='in_flight',delivery_round_id=?1
        WHERE turn_id=?2 AND call_id=?3 AND delivery_state='pending_delivery'",
            [round, turn, call],
        )
        .map_err(StorageError::sqlite)?;
    if changed == 1
        || read::find(db, turn, call)?.is_some_and(|row| {
            row.delivery_state.as_deref() == Some("in_flight")
                && row.delivery_round_id.as_deref() == Some(round)
        })
    {
        return Ok(());
    }
    fail("operation_result_delivery_begin_conflict")
}

pub(super) fn release(db: &Connection, turn: &str, round: &str) -> StorageResult<()> {
    validate_id(turn, "operation_result_turn_id_invalid")?;
    validate_id(round, "operation_result_round_id_invalid")?;
    let rows = delivery_rows(db, turn, round)?;
    let code = "operation_result_delivery_release_conflict";
    if (rows.is_empty() && has_in_flight(db, turn)?) || rows.iter().any(|row| row.0 != "in_flight")
    {
        return fail(code);
    }
    let changed=db.execute(
        "UPDATE btcc_guided_tool_calls SET delivery_state='pending_delivery',delivery_round_id=NULL
        WHERE turn_id=?1 AND delivery_state='in_flight' AND delivery_round_id=?2",[turn,round],
    ).map_err(StorageError::sqlite)?;
    if changed == rows.len() {
        Ok(())
    } else {
        fail(code)
    }
}

pub(super) fn acknowledge(
    db: &Connection,
    turn: &str,
    round: &str,
    hash: &str,
) -> StorageResult<()> {
    validate_id(turn, "operation_result_turn_id_invalid")?;
    validate_id(round, "operation_result_round_id_invalid")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return fail("operation_result_response_hash_invalid");
    }
    let rows = delivery_rows(db, turn, round)?;
    let code = "operation_result_delivery_acknowledgement_conflict";
    if rows.is_empty() && has_in_flight(db, turn)? {
        return fail(code);
    }
    if !rows.is_empty()
        && rows
            .iter()
            .all(|row| row.0 == "acknowledged" && row.1.as_deref() == Some(hash))
    {
        return Ok(());
    }
    if rows.iter().any(|row| row.0 != "in_flight") {
        return fail(code);
    }
    let changed=db.execute(
        "UPDATE btcc_guided_tool_calls SET delivery_state='acknowledged',delivery_response_sha256=?1
        WHERE turn_id=?2 AND delivery_state='in_flight' AND delivery_round_id=?3",params![hash,turn,round],
    ).map_err(StorageError::sqlite)?;
    if changed == rows.len() {
        Ok(())
    } else {
        fail(code)
    }
}

pub(super) fn promote(db: &Connection, turn: &str, call: &str) -> StorageResult<()> {
    let changed = db
        .execute(
            "UPDATE btcc_guided_tool_calls SET delivery_state='reference_only'
        WHERE turn_id=?1 AND call_id=?2 AND delivery_state='acknowledged'",
            [turn, call],
        )
        .map_err(StorageError::sqlite)?;
    if changed == 1
        || read::find(db, turn, call)?
            .is_some_and(|row| row.delivery_state.as_deref() == Some("reference_only"))
    {
        return Ok(());
    }
    fail("operation_result_delivery_promotion_conflict")
}

fn delivery_rows(
    db: &Connection,
    turn: &str,
    round: &str,
) -> StorageResult<Vec<(String, Option<String>)>> {
    let mut statement = db
        .prepare(
            "SELECT delivery_state,delivery_response_sha256 FROM btcc_guided_tool_calls
        WHERE turn_id=?1 AND delivery_round_id=?2",
        )
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([turn, round], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

fn has_in_flight(db: &Connection, turn: &str) -> StorageResult<bool> {
    db.query_row("SELECT 1 FROM btcc_guided_tool_calls WHERE turn_id=?1 AND delivery_state='in_flight' LIMIT 1",
        [turn], |_| Ok(())).optional().map(|row| row.is_some()).map_err(StorageError::sqlite)
}

fn validate_id(value: &str, code: &'static str) -> StorageResult<()> {
    if crate::public_text::trim_js_whitespace(value).is_empty() || value.len() > 256 {
        fail(code)
    } else {
        Ok(())
    }
}

fn fail<T>(code: &'static str) -> StorageResult<T> {
    Err(error(code, code))
}
