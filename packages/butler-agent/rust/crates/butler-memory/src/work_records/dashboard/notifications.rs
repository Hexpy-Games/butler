//! Source TaskNotificationQueue.pending projection for Work Dashboard.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::work_records::WorkRecordReadError;
use butler_core::locale::LocaleCollation;

/// A queued task notification (`runtime/task-notifications/*.json`).
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Notification {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    notification_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    task_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    origin_summary: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    created_at: Option<String>,
}

/// A delivery row of the dashboard.
#[derive(Serialize)]
pub(super) struct DeliveryItem<'a> {
    label: String,
    status: Option<&'a str>,
    summary: &'a str,
    actions: [RetryAction<'a>; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_id: Option<&'a str>,
}

/// The (disabled) retry action of a legacy notification.
#[derive(Serialize)]
struct RetryAction<'a> {
    action: &'static str,
    label: &'static str,
    enabled: bool,
    reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notification_id: Option<&'a str>,
}

/// Undelivered notifications (object files not marked `delivered`), oldest
/// first by collation of `createdAt`.
pub(super) fn pending(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<Vec<Notification>, WorkRecordReadError> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut notifications = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        if !value.is_object() {
            continue;
        }
        let notification: Notification = crate::lenient::view(&value);
        if notification.status.as_deref() == Some("delivered") {
            continue;
        }
        notifications.push(notification);
    }
    notifications.sort_by(|a, b| {
        collation.compare(
            a.created_at.as_deref().unwrap_or(""),
            b.created_at.as_deref().unwrap_or(""),
        )
    });
    Ok(notifications)
}

pub(super) fn item(value: &Notification, index: usize, debug: bool) -> DeliveryItem<'_> {
    let id = value.notification_id.as_deref().unwrap_or("");
    let task = value.task_id.as_deref().unwrap_or("");
    DeliveryItem {
        label: if debug {
            id.to_owned()
        } else {
            format!("Delivery {}", index + 1)
        },
        status: value.status.as_deref(),
        summary: value.origin_summary.as_deref().unwrap_or(task),
        actions: [RetryAction {
            action: "retry_delivery",
            label: "Retry delivery",
            enabled: false,
            reason: "No native delivery owner is available to retry legacy notifications.",
            task_id: debug.then_some(task),
            notification_id: debug.then_some(id),
        }],
        raw_id: debug.then_some(id),
    }
}
