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

/// Read runs, never telemetry turn ids. The expression index bounds ranged
/// reads even when durable timestamps use different RFC3339 UTC offsets.
pub(super) fn schedule_turns(
    db: &Connection,
    since_ts: Option<f64>,
) -> Result<HashSet<String>, AppStorageError> {
    let predicate = if since_ts.is_some() {
        "WHERE julianday(r.started_at) >= julianday(?1 / 1000.0, 'unixepoch')"
    } else {
        ""
    };
    let sql = format!(
        "SELECT r.turn_id,q.turn_id FROM app_automation_runs r
        LEFT JOIN session_queued_messages q ON q.id=r.queued_message_id {predicate}"
    );
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    let args: Vec<f64> = since_ts.into_iter().collect();
    let rows = statement
        .query_map(params_from_iter(args), |row| {
            Ok([row.get::<_, Option<String>>(0)?, row.get(1)?])
        })
        .map_err(AppStorageError::sqlite)?;
    let mut turns = HashSet::new();
    for row in rows {
        turns.extend(row.map_err(AppStorageError::sqlite)?.into_iter().flatten());
    }
    Ok(turns)
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
