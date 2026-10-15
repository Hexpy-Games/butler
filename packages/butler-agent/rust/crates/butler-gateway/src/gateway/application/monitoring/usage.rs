//! Batch App metadata enrichment after the Host's indexed usage projection.
use super::super::storage::AppStorageError;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

type Metadata = HashMap<String, (String, String)>;

pub(super) fn enrich(
    db: &Connection,
    view: &mut Value,
    scheduled: &HashSet<String>,
) -> Result<(), AppStorageError> {
    let Some(items) = view.get_mut("topSessions").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let ids: Vec<_> = items
        .iter()
        .filter_map(|item| item["sessionId"].as_str().map(str::to_owned))
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let metadata = metadata(db, &ids)?;
    for item in items {
        let session = item["sessionId"].as_str().unwrap_or_default();
        let schedule = scheduled.contains(session);
        if let Some((id, title)) = metadata.get(session) {
            item["sessionId"] = json!(id);
            item["title"] = json!(title);
            item["kind"] = json!(if schedule { "schedule" } else { "chat" });
        } else if schedule {
            item["kind"] = json!("schedule");
        }
    }
    Ok(())
}

fn metadata(db: &Connection, ids: &[String]) -> Result<Metadata, AppStorageError> {
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    // Both branches use indexes. Null hints retain the same legacy binding as
    // sessions::identity::resolve_owner, without one lookup per returned scope.
    let sql = format!(
        "SELECT c.runtime_session_hint,c.id,c.title
        FROM chats c WHERE c.runtime_session_hint IN ({placeholders})
            OR (c.runtime_session_hint IS NULL AND c.id IN ({placeholders}))"
    );
    let mut args: Vec<_> = ids.iter().cloned().map(Some).collect();
    args.extend(
        ids.iter()
            .map(|id| Some(id.strip_prefix("butler/app-").unwrap_or(id).to_owned())),
    );
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params_from_iter(args), |row| {
            let hint: Option<String> = row.get(0)?;
            let id: String = row.get(1)?;
            let runtime = hint.unwrap_or_else(|| crate::gateway::app_session_hint(&id));
            Ok((runtime, (id, row.get(2)?)))
        })
        .map_err(AppStorageError::sqlite)?;
    rows.collect::<Result<_, _>>()
        .map_err(AppStorageError::sqlite)
}

// Usage lives in the Host's incremental log index, not an App SQL table.
// json_each exposes its deduplicated window turns as a relation with one bound
// parameter, independent of window size. Each run/queue probe uses a turn index;
// dispatch completion time says nothing about when a turn's usage ends.
pub(crate) const SCHEDULE_SESSIONS_SQL: &str = "
    SELECT session.key FROM json_each(?1) session
    WHERE NOT EXISTS (
        SELECT 1 FROM json_each(session.value) turn
        WHERE NOT EXISTS (
            SELECT 1 FROM app_automation_runs r WHERE r.turn_id=turn.value
        ) AND NOT EXISTS (
            SELECT 1 FROM session_queued_messages q
            JOIN app_automation_runs r ON r.queued_message_id=q.id
            WHERE q.turn_id=turn.value
        )
    )";

pub(super) fn scheduled_sessions(
    db: &Connection,
    session_turns: &HashMap<String, HashSet<String>>,
) -> Result<HashSet<String>, AppStorageError> {
    if session_turns.is_empty() {
        return Ok(HashSet::new());
    }
    let turns = json!(session_turns).to_string();
    let mut statement = db
        .prepare(SCHEDULE_SESSIONS_SQL)
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([turns], |row| row.get(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<_, _>>()
        .map_err(AppStorageError::sqlite)
}

/// Resolve App ids through their durable binding; telemetry scopes stay intact.
pub(super) fn runtime_session(
    db: &Connection,
    id: &str,
) -> Result<(String, Option<String>), AppStorageError> {
    let fallback = crate::gateway::app_session_hint(id);
    let bound: Option<String> = db
        .query_row(
            "SELECT COALESCE(runtime_session_hint,?1) FROM chats WHERE id=?2",
            [fallback.as_str(), id],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let scope = bound.is_none().then(|| id.to_owned());
    Ok((bound.unwrap_or(fallback), scope))
}
