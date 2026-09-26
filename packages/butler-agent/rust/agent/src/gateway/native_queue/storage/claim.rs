//! Claim pending records by atomic rename before dispatch.

use std::{
    collections::HashSet,
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

use chrono::{DateTime, SecondsFormat, Utc};

use super::{
    io::{atomic_write, ensure_dir, file_names, read},
    record_path,
};
use crate::gateway::native_queue::{
    ClaimedInboundEvent, NativeQueueError, QueueResult, record::ProcessingLease,
};

const LEASE: Duration = Duration::from_secs(16 * 60);

pub(in crate::gateway::native_queue) fn claim(
    root: &Path,
    owner: &str,
    limit: usize,
    mut eligible: impl FnMut(&crate::gateway::native_queue::QueuedInboundEvent) -> bool,
) -> QueueResult<Vec<ClaimedInboundEvent>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    ensure_dir(&root.join("processing"))?;
    let mut result = Vec::with_capacity(limit.min(10));
    for name in file_names(&root.join("pending"))? {
        if result.len() >= limit {
            break;
        }
        let from = root.join("pending").join(&name);
        let to = root.join("processing").join(&name);
        let Some(mut record) = read(&from)? else {
            continue;
        };
        if !available(&record) || !eligible(&record) {
            continue;
        }
        if fs::rename(&from, &to).is_err() {
            continue;
        }
        let now = SystemTime::now();
        let claimed: DateTime<Utc> = now.into();
        let expires: DateTime<Utc> = now
            .checked_add(LEASE)
            .ok_or_else(|| {
                NativeQueueError::new("inbound_queue_time_invalid", "Invalid queue lease")
            })?
            .into();
        let lease = ProcessingLease {
            claim_id: uuid::Uuid::new_v4().to_string(),
            owner_id: owner.to_owned(),
            claimed_at: claimed.to_rfc3339_opts(SecondsFormat::Millis, true),
            lease_expires_at: expires.to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        record.attempts = record.attempts.saturating_add(1);
        record.processing = Some(lease.clone());
        atomic_write(&to, &record)?;
        result.push(ClaimedInboundEvent {
            record,
            path: to,
            processing: lease,
        });
    }
    Ok(result)
}

fn available(record: &crate::gateway::native_queue::QueuedInboundEvent) -> bool {
    if record
        .metadata
        .get("resumeAfterProcessId")
        .and_then(serde_json::Value::as_u64)
        == Some(u64::from(std::process::id()))
    {
        return false;
    }
    let Some(not_before) = record
        .metadata
        .get("notBefore")
        .and_then(serde_json::Value::as_str)
    else {
        return true;
    };
    let Ok(not_before) = DateTime::parse_from_rfc3339(not_before) else {
        return true;
    };
    not_before.timestamp_millis() <= chrono_now_millis()
}

fn chrono_now_millis() -> i64 {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.timestamp_millis()
}

pub(in crate::gateway::native_queue) fn recover_stale(
    root: &Path,
    owner: &str,
    active: &HashSet<String>,
) -> QueueResult<usize> {
    let mut recovered = 0;
    for name in file_names(&root.join("processing"))? {
        let path = root.join("processing").join(&name);
        let Some(mut record) = read(&path)? else {
            continue;
        };
        if active.contains(&record.queue_id) {
            continue;
        }
        let Some(lease) = record.processing.as_ref() else {
            continue;
        };
        let expired = DateTime::parse_from_rfc3339(&lease.lease_expires_at)
            .is_ok_and(|expires| expires.timestamp_millis() <= chrono_now_millis());
        let dead = owner_dead(&lease.owner_id);
        if !expired && !dead {
            continue;
        }
        if record_path(root, "processed", &record.queue_id).exists()
            || record_path(root, "failed", &record.queue_id).exists()
        {
            continue;
        }
        let pending = record_path(root, "pending", &record.queue_id);
        if pending.exists() || fs::rename(&path, &pending).is_err() {
            continue;
        }
        let previous = record.processing.take();
        record
            .metadata
            .insert("recoveredFromProcessing".into(), true.into());
        record.metadata.insert(
            "recoveryReason".into(),
            if dead {
                "processing_owner_dead"
            } else {
                "processing_lease_expired"
            }
            .into(),
        );
        let recovered_at: DateTime<Utc> = SystemTime::now().into();
        record.metadata.insert(
            "recoveredAt".into(),
            recovered_at
                .to_rfc3339_opts(SecondsFormat::Millis, true)
                .into(),
        );
        record
            .metadata
            .insert("recoveredBy".into(), owner.to_owned().into());
        if let Some(previous) = previous {
            record.metadata.insert(
                "previousProcessing".into(),
                serde_json::to_value(previous).map_err(|error| {
                    NativeQueueError::new("inbound_queue_encode_failed", error.to_string())
                })?,
            );
        }
        atomic_write(&pending, &record)?;
        recovered += 1;
    }
    Ok(recovered)
}

#[cfg(unix)]
fn owner_dead(owner: &str) -> bool {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
    let Some(pid) = owner
        .split(':')
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    matches!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH))
}

#[cfg(not(unix))]
fn owner_dead(_: &str) -> bool {
    false
}
