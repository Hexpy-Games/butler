//! App-only agent marks, derived from the latest status actor in one batch.
use super::*;

pub(super) fn enrich(db: &Connection, epics: &mut [Value]) -> Result<()> {
    let ids = json!(epics.iter().map(|e| &e["id"]).collect::<Vec<_>>()).to_string();
    let mut actors = std::collections::HashMap::new();
    for row in rows(db, "SELECT e.id,a.actor_json FROM json_each(?1) ids
        JOIN canon_epics e ON e.id=ids.value
        JOIN canon_activity a ON a.seq=(SELECT seq FROM canon_activity
            WHERE entity_id=e.id AND kind='status' ORDER BY seq DESC LIMIT 1)
        WHERE e.canon_status IN ('in_progress','in_review') AND json_extract(a.actor_json,'$.origin')='mcp'", [ids])? {
        let actor: Value = serde_json::from_str(text(&row, "actor_json")?)?;
        actors.insert(text(&row,"id")?.to_owned(), json!({"person":actor["person"],"via":actor["via"]}));
    }
    for epic in epics {
        epic["agent"] = actors.remove(text(epic, "id")?).unwrap_or(Value::Null);
    }
    Ok(())
}
