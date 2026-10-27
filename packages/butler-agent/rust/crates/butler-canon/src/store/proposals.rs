//! Independent canon drafts; no Work lifecycle or execution state is stored here.
mod apply;
mod operations;
pub mod queries;
pub mod specs;
mod target;
pub mod view;
use super::*;
pub use apply::apply;
use rusqlite::params;

pub const APPLIED_MESSAGE: &str = "Applied and bound to this conversation. If current Work serves this epic, put its epic_ref in governing_refs in your next replace_work_plan revision. Confirm briefly; do not start Work unless the user asked.";
pub const DRAFT_MESSAGE: &str = "Shown as a draft card. Nothing is written until the user answers on the card or in chat. Say in one short sentence what you drafted; do not list its fields.";

pub fn get(db: &Connection, id: &str) -> Result<Value> {
    let mut row = one(db, queries::GET, [id])?;
    row["document"] = serde_json::from_str(text(&row, "changes_json")?)?;
    Ok(row)
}

pub fn create(tx: &Transaction<'_>, ctx: &Context, row: &Value) -> Result<Value> {
    let id = text(row, "id")?;
    let session = text(row, "session_id")?;
    let document = &row["document"];
    let changes = document["changes"]
        .as_array()
        .ok_or(Error::Invalid("changes required"))?;
    if changes.is_empty() || text(row, "summary")?.trim().is_empty() {
        return Err(Error::Invalid("summary and changes required"));
    }
    let project = if document["new_name"].is_string() {
        "@new"
    } else {
        row["project_id"].as_str().unwrap_or("@new")
    };
    if let Err(error) = apply::validate(tx, ctx, project, changes) {
        return match error {
            Error::Conflict { current } => Ok(conflict_result(&current)),
            other => Err(other),
        };
    }
    for old in rows(tx, queries::OPEN_SESSION, [session])? {
        transition(tx, ctx, text(&old, "id")?, "superseded", None)?;
    }
    tx.execute(
        queries::INSERT,
        params![
            id,
            session,
            row["source_turn_id"].as_str(),
            row["source_call_id"].as_str(),
            row["project_id"].as_str(),
            row["summary"].as_str(),
            document.to_string(),
            row["created_at"].as_str()
        ],
    )?;
    notify(tx, ctx, &get(tx, id)?)?;
    Ok(json!({"ok":true,"state":"draft",
        "ask_id":format!("canon:{id}"),"message":DRAFT_MESSAGE}))
}

fn conflict_result(current: &Value) -> Value {
    json!({"ok":false,"error":{"code":"canon_conflict","message":format!(
        "'{}' changed before this was applied (now revision {}). Nothing was applied. Tell the user in one sentence; read it again before proposing.",
        current["title"].as_str().unwrap_or("Spec"), current["revision"].as_i64().unwrap_or(0))}})
}

pub fn transition(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    state: &str,
    by: Option<&str>,
) -> Result<Value> {
    let row = get(tx, id)?;
    if row["state"] != "open" {
        return Ok(row);
    }
    tx.execute(queries::RESOLVE, params![id, state, by, iso(tx, ctx.now)?])?;
    let row = get(tx, id)?;
    notify(tx, ctx, &row)?;
    Ok(row)
}

pub fn bind(tx: &Transaction<'_>, ctx: &Context, epic: &str, session: &str) -> Result<()> {
    super::entities::bind_session_with_home(tx, ctx, epic, session, false)
}

fn iso(db: &Connection, now: i64) -> Result<String> {
    Ok(db.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?1/1000.0,'unixepoch')",
        [now],
        |r| r.get(0),
    )?)
}
fn notify(tx: &Transaction<'_>, ctx: &Context, row: &Value) -> Result<()> {
    let count: i64 = tx.query_row(queries::COUNT, [text(row, "session_id")?], |r| r.get(0))?;
    let payload = json!({"session_id":row["session_id"],"ask_id":format!("canon:{}",text(row,"id")?),
        "proposal_id":row["id"],"kind":"canon_proposal","state":row["state"],"open_count":count});
    tx.execute(
        super::sql::OUTBOX,
        params!["pending_asks.changed", payload.to_string(), ctx.now],
    )?;
    Ok(())
}

/// Card selection changes the target only while the draft is open.
pub fn select_target(
    tx: &Transaction<'_>,
    id: &str,
    project: Option<&str>,
    name: Option<&str>,
) -> Result<Value> {
    let row = get(tx, id)?;
    if row["state"] != "open" {
        return Err(Error::Invalid("proposal is no longer open"));
    }
    let mut doc = row["document"].clone();
    doc["new_name"] = json!(name);
    let changes = doc["changes"]
        .as_array_mut()
        .ok_or(Error::Invalid("changes required"))?;
    changes.retain(|c| c["op"] != "project.create");
    if let Some(name) = name {
        changes.insert(
            0,
            json!({"op":"project.create","name":name,"project_ref":"@new"}),
        );
    }
    tx.execute(
        "UPDATE canon_proposals SET project_id=?2,changes_json=?3 WHERE id=?1",
        params![id, project, doc.to_string()],
    )?;
    get(tx, id)
}
pub fn turn_cards(db: &Connection, turns: &[String]) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    let mut stmt = db.prepare(queries::TURN)?;
    for turn in turns {
        let ids = stmt
            .query_map([turn], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            let row = get(db, &id)?;
            result.push(
                json!({"proposal_id":id,"turn_id":turn,"source_call_id":row["source_call_id"]}),
            );
        }
    }
    Ok(result)
}
