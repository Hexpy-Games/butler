//! Conversation reservation and projection intent commit on the BTCC lane.
use super::*;

pub fn applied(tx: &Transaction<'_>, ctx: &Context, op: &str, expected: i64) -> Result<Value> {
    let row = one(tx, super::super::sql::INTENT, [op])?;
    if row["state"] == "applied" {
        return Ok(row);
    }
    mark_intent_applied(tx, ctx, op, expected)
}

pub fn link(tx: &Transaction<'_>, ctx: &Context, id: &str, proposed: &str) -> Result<Value> {
    let old = canon_row(read_work(tx, id)?)?;
    if old["scope_kind"] != "project" {
        return Err(Error::NotFound);
    }
    let work = if old["home_session_id"].is_null() {
        assign_home(tx, ctx, id, revision(&old)?, Some(proposed))?
    } else {
        old
    };
    let session = text(&work, "home_session_id")?;
    let op_id = format!("canon-conversation:{id}:{session}");
    let payload = json!({"session_id":session,"work_id":id,
        "project_id":work["scope_ref"],"title":work["title"]});
    let intent = record_intent(tx, ctx, &op_id, "canon_conversation", &payload)?;
    Ok(json!({"session_id":session,"work":epic(tx,id)?,"intent":intent}))
}
