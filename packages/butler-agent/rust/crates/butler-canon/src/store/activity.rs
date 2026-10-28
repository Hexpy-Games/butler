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
    let epic = read_work(tx, id)?;
    let summary: String = input
        .body
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect();
    append(tx, ctx, id, "comment", &summary, Some(&input.body))?;
    grants::emit(
        tx,
        ctx,
        "canon.changed",
        &json!({"kind":"activity","id":id,"project_id":epic["project_id"],
        "origin":if ctx.actor["origin"]=="mcp" {"mcp"} else if ctx.actor["via"]=="butler" {"butler"} else {"local"}}),
    )?;
    Ok(json!({"id":id,"activity":page(tx,id,None)?["activity"]}))
}
pub fn page(db: &Connection, epic: &str, before: Option<i64>) -> Result<Value> {
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
        items.extend(rows(db,"SELECT seq,entity_id,kind,summary,body,actor_json,at FROM canon_activity WHERE entity_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT 51",params![text(&entity,"id")?,before.unwrap_or(i64::MAX)])?);
    }
    items.sort_by_key(|r| std::cmp::Reverse(r["seq"].as_i64()));
    let more = items.len() > 50;
    items.truncate(50);
    for row in &mut items {
        row["actor"] = serde_json::from_str(text(row, "actor_json")?)?;
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
    if let Some(changes) = row["document"]["changes"].as_array() {
        for change in changes.iter().filter(|c| c["op"] == "spec.edit") {
            append(
                tx,
                ctx,
                text(change, "id")?,
                kind,
                text(row, "summary")?,
                None,
            )?;
        }
    }
    Ok(())
}
