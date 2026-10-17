//! Terminal fencing and runtime-interruption recovery.
//!
//! A settlement's record is staged without the lane. Under it the claim is
//! checked and the record renamed into place; its directory is synced after
//! the lane is released, and only then is the claimed copy released.

use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::{
    STATES,
    io::{Committed, SETTLE, Staged, atomic_write, file_names, read, stage},
    record_path,
};
use crate::gateway::inbound_queue::{ClaimedInboundEvent, QueueResult, QueuedInboundEvent};

fn now() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn owns(item: &ClaimedInboundEvent) -> QueueResult<bool> {
    Ok(read(&item.path)?
        .and_then(|record| record.processing)
        .is_some_and(|lease| lease.claim_id == item.processing.claim_id))
}

/// How the claimed copy leaves `processing` once its settlement is durable.
#[derive(Clone, Copy)]
pub(in crate::gateway::inbound_queue) enum Release {
    Remove,
    SetAside(&'static str),
}

/// A staged settlement record for one claim.
pub(in crate::gateway::inbound_queue) struct Settlement {
    staged: Staged,
    release: Release,
}

/// A settlement renamed into place, durable after [`Committed::sync`].
pub(in crate::gateway::inbound_queue) struct Published {
    pub(in crate::gateway::inbound_queue) committed: Committed,
    pub(in crate::gateway::inbound_queue) release: Release,
}

fn staged(
    root: &Path,
    state: &str,
    record: &QueuedInboundEvent,
    release: Release,
) -> QueueResult<Settlement> {
    let path = record_path(root, state, &record.queue_id);
    Ok(Settlement {
        staged: stage(&path, record, true, SETTLE)?,
        release,
    })
}

/// Publishes `settlement` while `item` still owns its claim; the caller
/// holds the lane. A claim that moved on discards it.
pub(in crate::gateway::inbound_queue) fn publish(
    item: &ClaimedInboundEvent,
    settlement: Settlement,
) -> QueueResult<Option<Published>> {
    if !owns(item)? {
        return Ok(None);
    }
    Ok(Some(Published {
        committed: settlement.staged.commit()?,
        release: settlement.release,
    }))
}

/// Releases the claimed copy of a durable settlement unless the record was
/// claimed again meanwhile; the caller holds the lane.
pub(in crate::gateway::inbound_queue) fn release(
    item: &ClaimedInboundEvent,
    release: Release,
) -> QueueResult<()> {
    if owns(item)? {
        let _ = match release {
            Release::Remove => fs::remove_file(&item.path),
            Release::SetAside(extension) => {
                fs::rename(&item.path, item.path.with_extension(extension))
            }
        };
    }
    Ok(())
}

pub(in crate::gateway::inbound_queue) fn settle(
    root: &Path,
    item: &ClaimedInboundEvent,
    state: &str,
    error: Option<&str>,
    metadata: Value,
) -> QueueResult<Settlement> {
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
    // The terminal record is durable before the claimed copy is removed.
    staged(root, state, &record, Release::Remove)
}

pub(in crate::gateway::inbound_queue) fn park(
    root: &Path,
    item: &ClaimedInboundEvent,
    error: &str,
) -> QueueResult<Settlement> {
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
    staged(
        root,
        "pending",
        &record,
        Release::SetAside("json.interrupted"),
    )
}

/// First and longest wait before a deferred record is claimable again.
const DEFER_FIRST: Duration = Duration::from_secs(1);
const DEFER_MAX: Duration = Duration::from_secs(60);

/// Returns a claimed record to pending with its metadata, claimable again
/// once a backoff has passed (1 s, doubling per deferral, at most 60 s).
pub(in crate::gateway::inbound_queue) fn defer(
    root: &Path,
    item: &ClaimedInboundEvent,
    error: &str,
) -> QueueResult<Settlement> {
    let mut record = item.record.clone();
    record.processing = None;
    let deferrals = record
        .metadata
        .get("deferrals")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    let wait = DEFER_FIRST
        .saturating_mul(1 << deferrals.saturating_sub(1).min(6))
        .min(DEFER_MAX);
    let not_before: DateTime<Utc> = (SystemTime::now() + wait).into();
    record.metadata.insert("deferrals".into(), deferrals.into());
    record.metadata.insert(
        "notBefore".into(),
        not_before
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            .into(),
    );
    record.metadata.insert(
        "deferredError".into(),
        error.chars().take(500).collect::<String>().into(),
    );
    staged(root, "pending", &record, Release::SetAside("json.deferred"))
}

pub(in crate::gateway::inbound_queue) fn recover_runtime_interruptions(
    root: &Path,
) -> QueueResult<usize> {
    prune_terminal_files(root)?;
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

/// One startup pass over legacy tombstones, aged completed records and
/// records a crashed process staged but never renamed into place.
fn prune_terminal_files(root: &Path) -> QueueResult<()> {
    const PROCESSED_AGE: Duration = Duration::from_hours(720);
    const TOMBSTONES: [&str; 4] = [
        ".json.done",
        ".json.failed",
        ".json.interrupted",
        ".json.deferred",
    ];
    let now = SystemTime::now();
    for state in STATES {
        let entries = match fs::read_dir(root.join(state)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(super::io::io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(super::io::io_error)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let expired = || {
                entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .is_some_and(|modified| {
                        now.duration_since(modified)
                            .is_ok_and(|age| age >= PROCESSED_AGE)
                    })
            };
            if abandoned_staging(&name)
                || (state == "processing" && TOMBSTONES.iter().any(|end| name.ends_with(end)))
                || (state == "processed" && name.ends_with(".json") && expired())
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// A staging file whose writer is gone can never be renamed into place.
fn abandoned_staging(name: &str) -> bool {
    use butler_platform::process_control::{Liveness, liveness};
    butler_platform::secure_fs::staging_owner(name)
        .is_some_and(|pid| liveness(pid) == Liveness::Gone)
}
