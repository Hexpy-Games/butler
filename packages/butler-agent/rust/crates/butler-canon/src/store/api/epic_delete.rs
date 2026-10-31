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
    if runtime::epic_delete_running(tx, id)? {
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
    settle_panels(tx, ctx, id)?;
    stale_spec_drafts(tx, ctx, id)?;
    for sql in [
        "DELETE FROM canon_intents WHERE json_extract(payload_json,'$.work_id')=?1",
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

/// Preserve terminal panels as replayable intents, even when their first posting is in flight.
fn settle_panels(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    let panels = rows(
        tx,
        "SELECT op_id,kind,payload_json,state FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1 AND kind IN ('canon_hold','canon_take_here') ORDER BY rowid",
        [id],
    )?;
    let mut latest = std::collections::BTreeMap::new();
    for panel in panels {
        let payload: Value = serde_json::from_str(text(&panel, "payload_json")?)?;
        let source = payload["source_key"]
            .as_str()
            .unwrap_or(text(&panel, "op_id")?)
            .to_owned();
        latest.insert(
            source,
            (
                text(&panel, "kind")?.to_owned(),
                payload,
                panel["state"] == "pending",
            ),
        );
    }
    tx.execute(
        "DELETE FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1",
        [id],
    )?;
    for (source, (kind, mut payload, pending_answer)) in latest {
        if !pending_answer && !payload["state"].is_null() && payload["state"] != "pending" {
            continue;
        }
        payload["source_key"] = json!(source);
        // Earlier decisions are history; only unanswered panels become deleted.
        if payload["state"].is_null() || payload["state"] == "pending" {
            payload["state"] = json!("deleted");
        }
        record_intent(tx, ctx, &format!("{source}:epic-deleted"), &kind, &payload)?;
    }
    Ok(())
}

fn stale_spec_drafts(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    for node in rows(
        tx,
        "SELECT node_id FROM canon_spec_nodes WHERE epic_id=?1",
        [id],
    )? {
        for draft in rows(tx, super::sql::OPEN_MCP_SPEC, [text(&node, "node_id")?])? {
            super::super::proposals::transition(tx, ctx, text(&draft, "id")?, "stale", None)?;
        }
    }
    Ok(())
}
