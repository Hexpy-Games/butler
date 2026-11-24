//! Person-visible canon history, committed alongside each mutation.
use super::*;
use rusqlite::params;

pub fn append(
    tx: &Transaction<'_>,
    ctx: &Context,
    entity: &str,
    kind: &str,
    summary: &str,
    body: Option<&str>,
) -> Result<()> {
    tx.execute("INSERT INTO canon_activity(entity_id,actor_json,kind,summary,body,at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![entity,ctx.actor.to_string(),kind,summary,body,ctx.now])?;
    Ok(())
}
/// Preserve display summaries while recording status transitions without text parsing.
pub fn status(tx: &Transaction<'_>, ctx: &Context, id: &str, from: &str, to: &str) -> Result<()> {
    append(
        tx,
        ctx,
        id,
        "status",
        &format!("{from}→{to}"),
        Some(&json!({"from":from,"to":to}).to_string()),
    )
}
pub fn comment(tx: &Transaction<'_>, ctx: &Context, id: &str, input: Value) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        body: String,
    }
    let input: Input =
        serde_json::from_value(input).map_err(|_| Error::Invalid("invalid request fields"))?;
    if !(1..=8000).contains(&input.body.chars().count()) {
        return Err(Error::Invalid("body must be 1..8000 characters"));
    }
    let seq = record_comment(tx, ctx, id, &input.body)?;
    sync::capture_comment(tx, ctx, id, seq, &input.body)?;
    Ok(json!({"id":id,"activity":page_visible(tx,id,None,ctx.actor["origin"]=="mcp")?["activity"]}))
}
/// Writes one comment row and its change event; returns the row's `seq`.
pub(in crate::store) fn record_comment(
    tx: &Transaction<'_>,
    ctx: &Context,
    epic_id: &str,
    body: &str,
) -> Result<i64> {
    let epic = read_work(tx, epic_id)?;
    let summary: String = body
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect();
    append(tx, ctx, epic_id, "comment", &summary, Some(body))?;
    let seq = tx.last_insert_rowid();
    comment_changed(tx, ctx, epic_id, &epic["project_id"])?;
    Ok(seq)
}
/// The `canon.changed` activity event a comment write or removal emits.
pub(in crate::store) fn comment_changed(
    tx: &Transaction<'_>,
    ctx: &Context,
    epic_id: &str,
    project: &Value,
) -> Result<()> {
    let origin = if ctx.actor["origin"] == "mcp" {
        "mcp"
    } else if ctx.actor["via"] == "butler" {
        "butler"
    } else if ctx.actor["via"] == "sync" {
        "remote"
    } else {
        "local"
    };
    grants::emit(
        tx,
        ctx,
        "canon.changed",
        &json!({"kind":"activity","id":epic_id,"project_id":project,"origin":origin}),
    )
}
pub fn page(db: &Connection, epic: &str, before: Option<i64>) -> Result<Value> {
    page_visible(db, epic, before, false)
}
pub fn mcp_page(db: &Connection, epic: &str, before: Option<i64>) -> Result<Value> {
    page_visible(db, epic, before, true)
}
fn page_visible(db: &Connection, epic: &str, before: Option<i64>, mcp: bool) -> Result<Value> {
    read_work(db, epic)?;
    // Each entity seeks its own history index; only 51 rows per entity can win.
    let mut entities = rows(
        db,
        "SELECT node_id AS id FROM canon_spec_nodes WHERE epic_id=?1 AND scope_kind='project' AND visibility='canon'",
        [epic],
    )?;
    entities.push(json!({"id":epic}));
    let mut items = Vec::new();
    for entity in entities {
        items.extend(rows(db,"SELECT seq,entity_id,kind,summary,body,actor_json,at FROM canon_activity WHERE entity_id=?1 AND seq<?2 AND (?3=0 OR (kind NOT GLOB 'criterion_*' AND (kind NOT GLOB 'proposal_*' OR COALESCE(json_extract(actor_json,'$.proposal_source'),json_extract(actor_json,'$.origin'))='mcp'))) ORDER BY seq DESC LIMIT 51",params![text(&entity,"id")?,before.unwrap_or(i64::MAX),mcp])?);
    }
    items.sort_by_key(|r| std::cmp::Reverse(r["seq"].as_i64()));
    let more = items.len() > 50;
    items.truncate(50);
    for row in &mut items {
        row["actor"] = serde_json::from_str(text(row, "actor_json")?)?;
        if row["kind"] == "status" {
            if !mcp
                && let Some(data) = row["body"]
                    .as_str()
                    .and_then(|body| serde_json::from_str::<Value>(body).ok())
            {
                row["from"] = data["from"].clone();
                row["to"] = data["to"].clone();
            }
            row["body"] = Value::Null;
        }
        if let Some(o) = row.as_object_mut() {
            o.remove("actor_json");
        }
    }
    let cursor = more
        .then(|| items.last().map(|r| r["seq"].clone()))
        .flatten();
    Ok(json!({"activity":items,"activity_before":cursor}))
}

pub(super) fn proposal(tx: &Transaction<'_>, ctx: &Context, row: &Value, kind: &str) -> Result<()> {
    let mut ctx = ctx.clone();
    ctx.actor["proposal_source"] = row["source"].clone();
    if let Some(changes) = row["document"]["changes"].as_array() {
        for change in changes
            .iter()
            .filter(|c| matches!(c["op"].as_str(), Some("spec.edit" | "spec.create")))
        {
            append(
                tx,
                &ctx,
                text(change, "id")?,
                kind,
                text(row, "summary")?,
                None,
            )?;
        }
    }
    Ok(())
}
