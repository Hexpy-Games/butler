//! Conversation reservation and projection intent commit on the BTCC lane.
use super::*;

pub fn applied(tx: &Transaction<'_>, ctx: &Context, op: &str, expected: i64) -> Result<Value> {
    let row = one(tx, super::super::sql::INTENT, [op])?;
    if row["state"] == "applied" {
        return Ok(row);
    }
    mark_intent_applied(tx, ctx, op, expected)
}

pub fn link(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    proposed: Option<&str>,
    new_session: &str,
) -> Result<Value> {
    let work = read_work(tx, id)?;
    let sessions = rows(tx, super::super::sql::EPIC_SESSIONS, [id])?;
    let session = proposed
        .or_else(|| {
            sessions
                .iter()
                .find(|s| s["is_home"] == 1)
                .and_then(|s| s["session_id"].as_str())
        })
        .unwrap_or(new_session);
    bind_session(tx, ctx, id, session)?;
    tx.execute("UPDATE canon_session_epics SET is_home=1 WHERE epic_id=?1 AND session_id=?2 AND NOT EXISTS(SELECT 1 FROM canon_session_epics WHERE epic_id=?1 AND is_home=1)",rusqlite::params![id,session])?;
    let op_id = format!("canon-conversation:{id}:{session}");
    let payload = json!({"session_id":session,"work_id":id,
        "project_id":work["project_id"],"title":work["title"],
        "home_session_id":epic(tx,id)?["home_session_id"]});
    let intent = record_intent(tx, ctx, &op_id, "canon_conversation", &payload)?;
    Ok(json!({"session_id":session,"work":epic(tx,id)?,"intent":intent}))
}
