use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use sha1::{Digest as _, Sha1};
use sha2::Sha256;

use super::WorkStreamScope;
use crate::btcc::BtccError;

pub(super) const ACTIVE: &[&str] = &[
    "routing",
    "conception",
    "planning",
    "executing",
    "reviewing",
    "consolidating",
    "reporting",
];
pub(super) const TERMINAL: &[&str] = &["complete", "failed", "cancelled"];

pub(super) fn contract_field_defaults() -> [(&'static str, Value); 10] {
    [
        ("active_contract_id", Value::Null),
        ("claim_generation", Value::Null),
        ("claim_lease_expires_at", Value::Null),
        ("active_claim_receipt_id", Value::Null),
        ("original_claim_receipt_id", Value::Null),
        ("active_blocker_id", Value::Null),
        ("active_blocker_evidence_id", Value::Null),
        ("plan_revision", json!(1)),
        ("plan_revision_receipt_id", Value::Null),
        ("superseded_todo_ids", json!([])),
    ]
}

pub(super) fn open_lock(root: &Path, logical: &Path) -> Result<Connection, BtccError> {
    let digest = format!("{:x}", Sha256::digest(logical.to_string_lossy().as_bytes()));
    let shard = u32::from_str_radix(&digest[..8], 16).unwrap_or(0) % 64;
    let directory = root.join("runtime/mutation-lock-shards");
    fs::create_dir_all(&directory).map_err(io_error)?;
    let connection = Connection::open(directory.join(format!("mutation-lock-{shard:02}.sqlite3")))
        .map_err(sql_error)?;
    connection
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(sql_error)?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS shard_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO shard_fence(singleton,generation) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS active_lock(lock_key TEXT PRIMARY KEY,ownership_token TEXT NOT NULL,owner_id TEXT NOT NULL,acquired_at TEXT NOT NULL,renewed_at TEXT NOT NULL);")
      .map_err(sql_error)?;
    Ok(connection)
}

pub(super) fn todo_items(
    raw: Option<&Value>,
    prior: Option<&Value>,
    now: &str,
) -> Result<Vec<Value>, BtccError> {
    let values = raw
        .and_then(Value::as_array)
        .ok_or_else(|| error("todo_items_invalid"))?;
    if values.len() > 100 {
        return Err(error("todo_items_invalid"));
    }
    let prior_by_id: HashMap<String, &Value> = prior
        .and_then(|v| v.get("items"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| string(item, "id").map(|id| (id, item)))
        .collect();
    let mut seen = HashSet::new();
    let mut active_count = 0;
    let mut next_ordinal = prior_by_id
        .values()
        .filter_map(|v| integer(v, "ordinal"))
        .max()
        .unwrap_or(0)
        + 1;
    values.iter().enumerate().map(|(index,value)| {
        let object=value.as_object().ok_or_else(||error("todo_item_invalid"))?;
        let content=text(object.get("content"),600).ok_or_else(||error("todo_item_invalid"))?;
        let active_form=text(object.get("active_form"),600).ok_or_else(||error("todo_item_invalid"))?;
        let id=object.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(||{
            let mut hash=Sha1::new(); hash.update(format!("{content}\n{index}")); format!("todo-{:x}",hash.finalize())[..15].to_owned()
        });
        safe_id(&id,80)?; if !seen.insert(id.clone()){return Err(error("todo_item_duplicate"));}
        let status=object.get("status").and_then(Value::as_str).ok_or_else(||error("todo_status_invalid"))?;
        if !["pending","in_progress","completed","cancelled"].contains(&status){return Err(error("todo_status_invalid"));}
        if status=="in_progress"{active_count+=1;if active_count>1{return Err(error("todo_multiple_active"));}}
        let previous=prior_by_id.get(&id).copied(); let ordinal=previous.and_then(|v|integer(v,"ordinal")).unwrap_or_else(||{let value=next_ordinal;next_ordinal+=1;value});
        Ok(json!({"id":id,"ordinal":ordinal,"content":content,"active_form":active_form,"status":status,
          "phase":object.get("phase").cloned().unwrap_or(Value::Null),"priority":object.get("priority").cloned().unwrap_or(json!("normal")),
          "blocked_by":object.get("blocked_by").cloned().unwrap_or(json!([])),"note":object.get("note").cloned().unwrap_or(Value::Null),
          "created_at":previous.and_then(|v|string(v,"created_at")).unwrap_or_else(||now.into()),"updated_at":now,
          "completed_at":if status=="completed"{previous.and_then(|v|string(v,"completed_at")).map(Value::String).unwrap_or(json!(now))}else{Value::Null}}))
    }).collect()
}

pub(super) fn target(items: &[Value], prior: Option<&Value>) -> (String, Value, Value) {
    if let Some(active) = items
        .iter()
        .find(|item| string(item, "status").as_deref() == Some("in_progress"))
        && let Some(phase_name) = string(active, "phase")
    {
        let state = match phase_name.as_str() {
            "execution" => "executing",
            "review" => "reviewing",
            "consolidation" => "consolidating",
            "reporting" => "reporting",
            other => other,
        };
        return (
            state.into(),
            json!(phase_name),
            active.get("id").cloned().unwrap_or(Value::Null),
        );
    }
    if !items.is_empty()
        && items.iter().all(|item| {
            matches!(
                string(item, "status").as_deref(),
                Some("completed" | "cancelled")
            )
        })
    {
        let completed = items
            .iter()
            .rev()
            .find(|item| string(item, "status").as_deref() == Some("completed"))
            .and_then(|item| string(item, "phase"));
        return (
            if completed.as_deref() == Some("reporting") {
                "complete"
            } else {
                "reviewing"
            }
            .into(),
            completed.map(Value::String).unwrap_or(Value::Null),
            Value::Null,
        );
    }
    (
        prior
            .and_then(|v| string(v, "state"))
            .unwrap_or_else(|| "routing".into()),
        prior
            .and_then(|v| v.get("current_phase"))
            .cloned()
            .unwrap_or(Value::Null),
        prior
            .and_then(|v| v.get("active_step_id"))
            .cloned()
            .unwrap_or(Value::Null),
    )
}

pub(super) fn progress(items: &[Value]) -> Value {
    let count = |s: &str| {
        items
            .iter()
            .filter(|i| string(i, "status").as_deref() == Some(s))
            .count()
    };
    let pending = count("pending");
    let active = count("in_progress");
    let completed = count("completed");
    let cancelled = count("cancelled");
    let denominator = pending + active + completed;
    json!({"total":items.len(),"pending":pending,"in_progress":active,"completed":completed,"cancelled":cancelled,"active":pending+active,"progress_pct":if denominator==0{100}else{(completed*100+denominator/2)/denominator},"current":items.iter().find(|i|string(i,"status").as_deref()==Some("in_progress")).cloned()})
}
pub(super) fn stable_stream_id(scope: &WorkStreamScope, list: &str) -> String {
    let mut h = Sha1::new();
    h.update(format!(
        "{}\n{}\n{}\n{list}",
        scope.session_id,
        scope.origin_chat_id.as_deref().unwrap_or(""),
        scope.project_id.as_deref().unwrap_or("")
    ));
    format!("ws-{:x}", h.finalize())[..19].into()
}
pub(super) fn revision_stream_id(base: &str, now: &str) -> String {
    let mut h = Sha1::new();
    h.update(format!("{base}\n{now}"));
    format!("{}-{:x}", &base[..base.len().min(111)], h.finalize())[..base.len().min(111) + 9].into()
}
pub(super) fn active(record: &Value, turn: Option<&str>) -> bool {
    let state = string(record, "state");
    state.as_deref().is_some_and(|s| ACTIVE.contains(&s))
        || (state.as_deref() == Some("waiting_user")
            && turn.is_some()
            && string(record, "last_user_turn_id").as_deref() == turn)
}
pub(super) fn visible(record: &Value, turn: Option<&str>) -> bool {
    [
        "linked_planned_task_ids",
        "linked_orchestration_ids",
        "linked_worker_task_ids",
    ]
    .iter()
    .any(|k| {
        array(Some(record), k)
            .as_array()
            .is_some_and(|values| !values.is_empty())
    }) || string(record, "last_user_turn_id").is_none()
        || string(record, "last_user_turn_id").as_deref() == turn
}
pub(super) fn terminal(record: &Value) -> bool {
    string(record, "state")
        .as_deref()
        .is_some_and(|s| TERMINAL.contains(&s))
}
pub(super) fn summary(r: &Value) -> Value {
    let mut result = Map::from_iter([
        ("id".into(), r["id"].clone()),
        ("title".into(), r["title"].clone()),
        ("state".into(), r["state"].clone()),
        ("terminal".into(), json!(terminal(r))),
        ("updated_at".into(), r["updated_at"].clone()),
    ]);
    for key in [
        "owner_session_id",
        "project_id",
        "current_phase",
        "active_step_id",
        "todo_list_id",
    ] {
        if let Some(value) = r.get(key).filter(|value| !value.is_null()) {
            result.insert(key.into(), value.clone());
        }
    }
    Value::Object(result)
}
pub(super) fn phase(state: &str, prior: Option<&Value>) -> Value {
    match state {
        "conception" => json!("conception"),
        "planning" => json!("planning"),
        "executing" => json!("execution"),
        "reviewing" => json!("review"),
        "consolidating" => json!("consolidation"),
        "reporting" => json!("reporting"),
        "routing" | "complete" | "failed" | "cancelled" => Value::Null,
        _ => prior.cloned().unwrap_or(Value::Null),
    }
}
pub(super) fn validate_state(state: &str) -> Result<(), BtccError> {
    if ACTIVE
        .iter()
        .chain(
            [
                "waiting_user",
                "paused",
                "complete",
                "failed",
                "recoverable",
                "cancelled",
            ]
            .iter(),
        )
        .any(|v| *v == state)
    {
        Ok(())
    } else {
        Err(error("work_stream_state_invalid"))
    }
}
pub(super) fn validate_transition(from: &str, to: &str) -> Result<(), BtccError> {
    if from == to {
        return Ok(());
    }
    let allowed = match from {
        "routing" => &[
            "conception",
            "planning",
            "waiting_user",
            "recoverable",
            "failed",
            "cancelled",
        ][..],
        "conception" => &[
            "planning",
            "waiting_user",
            "paused",
            "recoverable",
            "failed",
            "cancelled",
        ],
        "planning" => &[
            "executing",
            "waiting_user",
            "paused",
            "recoverable",
            "failed",
            "cancelled",
        ],
        "executing" => &[
            "reviewing",
            "waiting_user",
            "paused",
            "recoverable",
            "failed",
            "cancelled",
        ],
        "reviewing" => &[
            "executing",
            "consolidating",
            "waiting_user",
            "paused",
            "recoverable",
            "failed",
            "cancelled",
        ],
        "consolidating" => &[
            "reporting",
            "reviewing",
            "recoverable",
            "failed",
            "cancelled",
        ],
        "reporting" => &[
            "complete",
            "reviewing",
            "recoverable",
            "failed",
            "cancelled",
        ],
        "waiting_user" | "paused" => &[
            "planning",
            "executing",
            "reviewing",
            "paused",
            "failed",
            "cancelled",
        ],
        "failed" => &["recoverable"],
        "recoverable" => &["executing", "reviewing", "failed", "cancelled"],
        _ => &[],
    };
    if allowed.contains(&to) {
        Ok(())
    } else {
        Err(error("work_stream_transition_invalid"))
    }
}
pub(super) fn list_id(raw: Option<&Value>, turn: &str) -> Result<String, BtccError> {
    let explicit = raw
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "main");
    let id = explicit.map(str::to_owned).unwrap_or_else(|| {
        format!(
            "{}:main",
            turn.chars()
                .map(|c| if c.is_ascii_alphanumeric() || "._:-".contains(c) {
                    c
                } else {
                    '-'
                })
                .take(70)
                .collect::<String>()
        )
        .chars()
        .take(80)
        .collect()
    });
    safe_id(&id, 80)?;
    Ok(id)
}
pub(super) fn safe_id(value: &str, max: usize) -> Result<(), BtccError> {
    if !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
    {
        Ok(())
    } else {
        Err(error("work_stream_id_invalid"))
    }
}
pub(super) fn text(value: Option<&Value>, limit: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|v| v.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(limit).collect())
}
pub(super) fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
pub(super) fn integer(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}
pub(super) fn array(source: Option<&Value>, key: &str) -> Value {
    source
        .and_then(|v| v.get(key))
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]))
}
pub(super) fn read_object(path: &Path) -> Result<Option<Value>, BtccError> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}
pub(super) fn write_atomic(path: &Path, value: &Value) -> Result<(), BtccError> {
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| error("work_stream_path_invalid"))?,
    )
    .map_err(io_error)?;
    let temp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| error("work_stream_record_invalid"))?;
    bytes.push(b'\n');
    fs::write(&temp, bytes).map_err(io_error)?;
    fs::rename(temp, path).map_err(io_error)
}
pub(super) fn error(code: &'static str) -> BtccError {
    failure(code, code)
}
pub(super) fn failure(code: &'static str, message: impl std::fmt::Display) -> BtccError {
    BtccError::relayed(code, message.to_string())
}
pub(super) fn io_error(e: std::io::Error) -> BtccError {
    failure("work_stream_io_failed", e)
}
pub(super) fn sql_error(e: rusqlite::Error) -> BtccError {
    failure("work_stream_lock_failed", e)
}

pub(super) fn now_iso() -> String {
    let now: DateTime<Utc> = std::time::SystemTime::now().into();
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
