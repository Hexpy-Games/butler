//! Local deletion; BTCC and conversation history remain independent.
use super::*;
use rusqlite::params;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteInput {
    expected_revision: i64,
}
pub(super) fn delete(tx: &Transaction<'_>, ctx: &Context, id: &str, value: Value) -> Result<Value> {
    let input: DeleteInput = input(value)?;
    let old = read_work(tx, id)?;
    cas(&old, "revision", input.expected_revision)?;
    if runtime::epic_running(tx, id)? {
        return Err(Error::Running);
    }
    // Snapshot the identity for the durable outbox before removing the row.
    event_with_details(
        tx,
        ctx,
        ("work", id, revision(&old)?, "delete"),
        &json!({"deleted":true,"title":old["title"]}),
    )?;
    super::super::queue::epic_deleted(tx, ctx, id)?;
    for sql in [
        "DELETE FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1",
        "DELETE FROM canon_intents WHERE json_extract(payload_json,'$.work_id')=?1",
        "DELETE FROM canon_step_cancellations WHERE epic_id=?1",
        "DELETE FROM canon_session_epics WHERE epic_id=?1",
        "DELETE FROM canon_epic_work_links WHERE epic_id=?1",
    ] {
        tx.execute(sql, [id])?;
    }
    // Spec content and immutable revisions survive as unbound specs in their scope.
    tx.execute("UPDATE canon_spec_nodes SET epic_id=NULL,revision=revision+1,updated_at=?2 WHERE epic_id=?1", params![id,ctx.now])?;
    tx.execute("DELETE FROM canon_epics WHERE id=?1", [id])?;
    let project = text(&old, "project_id")?;
    count(tx, ("project", project), "epics", -1)?;
    canon::bump_order(tx, ctx, old["plan_id"].as_str(), project)?;
    Ok(json!({"id":id,"title":old["title"],"deleted":true}))
}
