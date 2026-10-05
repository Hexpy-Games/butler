//! The next durable backoff deadline; no periodic work when the queue is idle.
use super::io::{file_names, read};
use crate::gateway::inbound_queue::QueueResult;
use chrono::{DateTime, Utc};
use std::{path::Path, time::Duration};

pub(in crate::gateway::inbound_queue) fn next_delay(root: &Path) -> QueueResult<Option<Duration>> {
    let now = Utc::now().timestamp_millis();
    // Keep the original owner-death/lease probe only while unfinished claims
    // exist. An external claimant can die without changing its lease file.
    let mut earliest = if file_names(&root.join("processing"))?.is_empty() {
        None
    } else {
        Some(500_u64)
    };
    for name in file_names(&root.join("pending"))? {
        let Some(record) = read(&root.join("pending").join(name))? else {
            continue;
        };
        if record
            .metadata
            .get("resumeAfterProcessId")
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(std::process::id()))
        {
            continue;
        }
        let Some(stamp) = record
            .metadata
            .get("notBefore")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Ok(stamp) = DateTime::parse_from_rfc3339(stamp) else {
            continue;
        };
        let remaining = stamp.timestamp_millis().saturating_sub(now);
        if let Ok(remaining) = u64::try_from(remaining)
            && remaining > 0
        {
            earliest = Some(earliest.map_or(remaining, |prior: u64| prior.min(remaining)));
        }
    }
    Ok(earliest.map(Duration::from_millis))
}
