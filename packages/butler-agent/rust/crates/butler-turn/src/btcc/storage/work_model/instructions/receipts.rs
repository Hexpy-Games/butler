//! Operation links are append-only; events carry explicit deltas, reads are complete.
use super::*;

pub(super) fn record(db: &Connection, id: &str, receipt: &mut Value) -> Result<Value> {
    let mut added = Vec::new();
    for operation in receipt
        .get("operation_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let operation = operation
            .as_str()
            .ok_or_else(|| error("instruction_integrity_error"))?;
        if db.execute("INSERT OR IGNORE INTO wm_instruction_operations(instruction_id,operation_id) VALUES(?1,?2)",params![id,operation]).map_err(sql)? > 0 {
            added.push(Value::from(operation));
        }
    }
    let count = receipt
        .get("operation_count")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        + added.len() as u64;
    set(receipt, "operation_count", json!(count))?;
    let mut delta = receipt.clone();
    delta
        .as_object_mut()
        .ok_or_else(|| error("instruction_integrity_error"))?
        .remove("operation_ids");
    set(&mut delta, "operation_ids_delta", json!(added))?;
    Ok(delta)
}

pub(super) fn hydrate(db: &Connection, mut receipt: Value) -> Result<Value> {
    let id = receipt
        .get("instruction_id")
        .and_then(Value::as_str)
        .ok_or_else(|| error("instruction_integrity_error"))?;
    let mut statement = db.prepare_cached("SELECT operation_id FROM wm_instruction_operations WHERE instruction_id=?1 ORDER BY seq").map_err(sql)?;
    let ids = statement
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    check(
        receipt
            .get("operation_count")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            == ids.len() as u64,
        "instruction_integrity_error",
    )?;
    receipt
        .as_object_mut()
        .ok_or_else(|| error("instruction_integrity_error"))?
        .remove("operation_ids_delta");
    set(&mut receipt, "operation_ids", json!(ids))?;
    Ok(receipt)
}

/// The operation audit and its outbox event also acknowledge its instruction.
/// Both updates share the graph transaction; no second audit/event is needed.
pub(super) fn acknowledge(
    db: &Connection,
    session: &str,
    id: &str,
    receipt: &mut Value,
    result: &Value,
) -> Result<()> {
    let seq = result["event_seq"]
        .as_u64()
        .ok_or_else(|| error("instruction_integrity_error"))?;
    set(receipt, "event_seq", json!(seq))?;
    let delta = record(db, id, receipt)?;
    db.execute(
        "UPDATE wm_instructions SET receipt_json=?1,status='applied' WHERE id=?2",
        params![encode(&delta)?, id],
    )
    .map_err(sql)?;
    db.execute(
        "UPDATE wm_audit SET instruction_id=?1 WHERE seq=?2",
        params![id, seq],
    )
    .map_err(sql)?;
    let existing: Option<String> = db
        .query_row(
            "SELECT event_json FROM wm_outbox WHERE seq=?1",
            [seq],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    let mut event = existing
        .map(|e| decode::<Value>(&e))
        .transpose()?
        .unwrap_or_else(|| json!({"kind":"instruction.updated","event_seq":seq}));
    set(&mut event, "session_id", json!(session))?;
    set(&mut event, "instruction_id", json!(id))?;
    set(&mut event, "receipt", delta)?;
    db.execute("INSERT INTO wm_outbox VALUES(?1,?2) ON CONFLICT(seq) DO UPDATE SET event_json=excluded.event_json", params![seq,encode(&event)?]).map_err(sql)?;
    Ok(())
}
