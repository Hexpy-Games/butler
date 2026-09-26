//! Source TaskNotificationQueue.pending projection for Work Dashboard.

use std::path::Path;

use serde_json::{Value, json};

use crate::{locale::LocaleCollation, work_records::WorkRecordReadError};

pub(super) fn pending(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<Vec<Value>, WorkRecordReadError> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut notifications = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|_| WorkRecordReadError)? {
        let entry = entry.map_err(|_| WorkRecordReadError)?;
        if !entry.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if !value.is_object() || value.get("status").and_then(Value::as_str) == Some("delivered") {
            continue;
        }
        notifications.push(value);
    }
    notifications.sort_by(|a, b| collation.compare(text(a, "createdAt"), text(b, "createdAt")));
    Ok(notifications)
}

pub(super) fn item(value: &Value, index: usize, debug: bool) -> Value {
    let id = text(value, "notificationId");
    let status = value.get("status").cloned().unwrap_or(Value::Null);
    let task = text(value, "taskId");
    let summary = value
        .get("originSummary")
        .and_then(Value::as_str)
        .unwrap_or(task);
    let mut action = json!({
        "action":"retry_delivery",
        "label":"Retry delivery",
        "enabled":false,
        "reason":"No native delivery owner is available to retry legacy notifications."
    });
    if debug {
        action["task_id"] = task.into();
        action["notification_id"] = id.into();
    }
    let mut output = json!({
        "label":if debug { id.to_owned() } else { format!("Delivery {}",index+1) },
        "status":status,"summary":summary,"actions":[action]
    });
    if debug {
        output["raw_id"] = id.into();
    }
    output
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
