//! Terminal fencing and runtime-interruption recovery.

use std::{fs, path::Path, time::SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::{
    io::{atomic_write, file_names, read},
    record_path,
};
use crate::gateway::native_queue::{ClaimedInboundEvent, QueueResult};

fn now() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn owns(item: &ClaimedInboundEvent) -> QueueResult<bool> {
    Ok(read(&item.path)?
        .and_then(|record| record.processing)
        .is_some_and(|lease| lease.claim_id == item.processing.claim_id))
}

pub(in crate::gateway::native_queue) fn settle(
    root: &Path,
    item: &ClaimedInboundEvent,
    state: &str,
    error: Option<&str>,
    metadata: Value,
) -> QueueResult<bool> {
    if !owns(item)? {
        return Ok(false);
    }
    let mut record = item.record.clone();
    record.processing = None;
    let timestamp = now();
    record.extra.insert(
        if state == "processed" {
            "processedAt"
        } else {
            "failedAt"
        }
        .into(),
        timestamp.into(),
    );
    if let Some(error) = error {
        record.extra.insert(
            "error".into(),
            error.chars().take(500).collect::<String>().into(),
        );
    }
    if let Value::Object(metadata) = metadata {
        record.metadata.extend(metadata);
    }
    record.metadata.insert(
        "terminalClaimId".into(),
        item.processing.claim_id.clone().into(),
    );
    atomic_write(&record_path(root, state, &record.queue_id), &record)?;
    let suffix = if state == "processed" {
        "done"
    } else {
        "failed"
    };
    let _ = fs::rename(
        &item.path,
        item.path.with_extension(format!("json.{suffix}")),
    );
    Ok(true)
}

pub(in crate::gateway::native_queue) fn park(
    root: &Path,
    item: &ClaimedInboundEvent,
    error: &str,
) -> QueueResult<bool> {
    if !owns(item)? {
        return Ok(false);
    }
    let mut record = item.record.clone();
    record.processing = None;
    record
        .metadata
        .insert("recoveredFromRuntimeInterruption".into(), true.into());
    record
        .metadata
        .insert("sameLogicalTurnContinuation".into(), true.into());
    record.metadata.insert("interruptedAt".into(), now().into());
    record.metadata.insert(
        "interruptionError".into(),
        error.chars().take(500).collect::<String>().into(),
    );
    record.metadata.insert(
        "resumeAfterProcessId".into(),
        u64::from(std::process::id()).into(),
    );
    record.metadata.insert(
        "interruptedClaimId".into(),
        item.processing.claim_id.clone().into(),
    );
    atomic_write(&record_path(root, "pending", &record.queue_id), &record)?;
    let _ = fs::rename(&item.path, item.path.with_extension("json.interrupted"));
    Ok(true)
}

pub(in crate::gateway::native_queue) fn recover_runtime_interruptions(
    root: &Path,
) -> QueueResult<usize> {
    let mut recovered = 0;
    for name in file_names(&root.join("failed"))? {
        let from = root.join("failed").join(&name);
        let Some(mut record) = read(&from)? else {
            continue;
        };
        if record
            .metadata
            .get("dispatchStatus")
            .and_then(Value::as_str)
            != Some("runtime-interrupted")
        {
            continue;
        }
        if ["pending", "processing", "processed"]
            .iter()
            .any(|state| record_path(root, state, &record.queue_id).exists())
        {
            continue;
        }
        record.processing = None;
        record.extra.remove("failedAt");
        record.extra.remove("error");
        record
            .metadata
            .insert("recoveredFromRuntimeInterruption".into(), true.into());
        record.metadata.insert("recoveredAt".into(), now().into());
        record.metadata.remove("resumeAfterProcessId");
        atomic_write(&record_path(root, "pending", &record.queue_id), &record)?;
        let _ = fs::rename(&from, from.with_extension("json.recovered"));
        recovered += 1;
    }
    Ok(recovered)
}
