use super::*;
use rusqlite::params;
/// Use this wrapper when a domain mutation needs an App DB projection. Replay
/// returns the original receipt before invoking the mutation closure.
pub fn with_intent(
    tx: &Transaction<'_>,
    ctx: &Context,
    op_id: &str,
    kind: &str,
    payload: &Value,
    change: impl FnOnce(&Transaction<'_>) -> Result<()>,
) -> Result<Value> {
    match one(tx, sql::INTENT, [op_id]) {
        Ok(row) => return Ok(row),
        Err(Error::NotFound) => {}
        Err(e) => return Err(e),
    }
    change(tx)?;
    record_intent(tx, ctx, op_id, kind, payload)
}
pub fn record_intent(
    tx: &Transaction<'_>,
    ctx: &Context,
    op_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<Value> {
    let inserted = tx.execute(
        sql::INSERT_INTENT,
        params![op_id, kind, payload.to_string(), ctx.now],
    )?;
    if inserted > 0 {
        event(tx, ctx, "intent", op_id, 0, "record")?;
    }
    one(tx, sql::INTENT, [op_id])
}
pub fn pending_intents(db: &Connection, after: &str, limit: usize) -> Result<Vec<Value>> {
    rows(db, sql::PENDING_INTENTS, params![after, limit])
}
pub fn mark_intent_applied(
    tx: &Transaction<'_>,
    ctx: &Context,
    op_id: &str,
    expected_revision: i64,
) -> Result<Value> {
    let row = one(tx, sql::INTENT, [op_id])?;
    cas(&row, "revision", expected_revision)?;
    if row["state"] != "applied" {
        tx.execute(sql::APPLY_INTENT, params![op_id, expected_revision])?;
        event(tx, ctx, "intent", op_id, expected_revision + 1, "applied")?;
    }
    one(tx, sql::INTENT, [op_id])
}
