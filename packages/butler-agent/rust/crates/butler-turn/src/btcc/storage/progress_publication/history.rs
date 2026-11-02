//! Activity window reads use the session turn index and one indexed event query.
use super::{StorageError, StorageProgressPublication, StorageResult};
use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Value, json};

impl StorageProgressPublication {
    /// Current events and prior child turns in one event query for the message window.
    /// `first=None` starts at the session's beginning; `latest` is projected separately.
    pub async fn read_child_activity_window(
        &self,
        session: String,
        first: Option<String>,
        latest: String,
    ) -> StorageResult<Value> {
        self.storage
            .read(move |db| read(db, &session, first.as_deref(), &latest))
            .await
    }
}

fn read(db: &Connection, session: &str, first: Option<&str>, latest: &str) -> StorageResult<Value> {
    let mut statement = db.prepare("SELECT t.turn_id,COALESCE(m.created_at,w.created_at) FROM btcc_turns t INDEXED BY idx_btcc_turns_session LEFT JOIN btcc_messages m ON m.message_id=t.original_message_id LEFT JOIN btcc_continuation_triggers w ON w.trigger_id=t.original_message_id WHERE t.session_id=?1 AND t.rowid>=CASE WHEN ?2 IS NULL THEN 0 ELSE (SELECT rowid FROM btcc_turns WHERE turn_id=?2 AND session_id=?1) END AND t.rowid<(SELECT rowid FROM btcc_turns WHERE turn_id=?3 AND session_id=?1) AND EXISTS(SELECT 1 FROM btcc_session_relations r WHERE r.child_session_id=t.session_id) ORDER BY t.rowid").map_err(StorageError::sqlite)?;
    let turns = statement
        .query_map(params![session, first, latest], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    let mut ids = turns.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    ids.push(latest.to_owned());
    let events = events(db, &ids)?;
    let mut by_turn: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for event in events {
        if let Some(turn) = event.get("turnId").and_then(Value::as_str) {
            by_turn.entry(turn.to_owned()).or_default().push(event);
        }
    }
    let latest_events = by_turn.remove(latest).unwrap_or_default();
    let history = turns
        .into_iter()
        .map(|(id, at)| {
            let rows = by_turn.remove(&id).unwrap_or_default();
            json!({"turn_id":id,"created_at":at,"public_progress_events":rows})
        })
        .collect::<Vec<_>>();
    Ok(json!({"activity_history":history,"public_progress_events":latest_events}))
}

pub(super) fn events(db: &Connection, turns: &[String]) -> StorageResult<Vec<Value>> {
    if turns.is_empty() {
        return Ok(Vec::new());
    }
    let slots = std::iter::repeat_n("?", turns.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT p.event_id,p.turn_sequence,p.event_json,p.created_at,p.turn_id FROM btcc_progress_events p INDEXED BY idx_btcc_progress_events_turn JOIN btcc_turns t ON t.turn_id=p.turn_id AND t.session_id=p.session_id WHERE p.turn_id IN ({slots}) AND EXISTS(SELECT 1 FROM btcc_session_relations r WHERE r.child_session_id=t.session_id) ORDER BY p.turn_id,p.turn_sequence,p.event_id"
    );
    let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(params_from_iter(turns), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    let mut events = Vec::new();
    for row in rows {
        let (id, sequence, raw, at, turn) = row.map_err(StorageError::sqlite)?;
        let Ok(mut event) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if event.get("visibility").and_then(Value::as_str) != Some("public") {
            continue;
        }
        let Some(object) = event.as_object_mut() else {
            continue;
        };
        object.insert("id".into(), id.into());
        object.insert("turnId".into(), turn.into());
        object.insert("turnSequence".into(), sequence.into());
        if object.get("createdAt").and_then(Value::as_str).is_none() {
            let payload_at = object
                .get("payload")
                .and_then(|p| p.get("createdAt"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            object.insert("createdAt".into(), payload_at.unwrap_or(at).into());
        }
        events.push(event);
    }
    Ok(events)
}
