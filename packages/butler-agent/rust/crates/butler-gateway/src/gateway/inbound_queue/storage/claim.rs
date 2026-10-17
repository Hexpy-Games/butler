//! Claim pending records by atomic rename before dispatch.
//!
//! Each leased copy is staged and synced without the lane; under it a claim
//! is only the rename out of `pending`, while that record is unchanged, and
//! the rename of the staged lease over it.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use chrono::{DateTime, SecondsFormat, Utc};

use super::{
    io::{
        CLAIM, Committed, Staged, atomic_write, ensure_dir, file_names, io_error, parse, read,
        read_raw, stage,
    },
    record_path,
};
use crate::gateway::InboundQueueCode;
use crate::gateway::inbound_queue::record::ProcessingLease;
use crate::gateway::inbound_queue::{
    ClaimedInboundEvent, InboundQueueError, QueueResult, QueuedInboundEvent,
};

const LEASE: Duration = Duration::from_mins(16);
/// Stub-only pause after a lease is staged, before any claim rename.
const CLAIM_HOLD: &str = "inbound_claim_staged";

/// A pending record chosen without the lane, with its leased copy staged.
pub(in crate::gateway::inbound_queue) struct Candidate {
    from: PathBuf,
    snapshot: Vec<u8>,
    item: ClaimedInboundEvent,
    staged: Staged,
}

/// Records claimed under the lane; durable once [`Claimed::finish`] returns.
pub(in crate::gateway::inbound_queue) struct Claimed {
    items: Vec<ClaimedInboundEvent>,
    committed: Option<Committed>,
    /// Leases of candidates that changed meanwhile, removed after the lane.
    discarded: Vec<Staged>,
}

/// Chooses up to `limit` claimable records in queue order and stages their
/// leases; no record changes state yet.
pub(in crate::gateway::inbound_queue) fn select(
    root: &Path,
    owner: &str,
    limit: usize,
    mut eligible: impl FnMut(&QueuedInboundEvent) -> bool,
) -> QueueResult<Vec<Candidate>> {
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
        let Some(snapshot) = read_raw(&from)? else {
            continue;
        };
        let Some(mut record) = parse(&snapshot) else {
            continue;
        };
        if !available(&record) || !eligible(&record) {
            continue;
        }
        let lease = lease(owner)?;
        record.attempts = record.attempts.saturating_add(1);
        record.processing = Some(lease.clone());
        let to = root.join("processing").join(&name);
        let staged = stage(&to, &record, true, CLAIM)?;
        butler_platform::secure_fs::hold_point(CLAIM_HOLD, || false).map_err(io_error)?;
        result.push(Candidate {
            from,
            snapshot,
            item: ClaimedInboundEvent {
                record,
                path: to,
                processing: lease,
            },
            staged,
        });
    }
    Ok(result)
}

/// Claims each candidate whose pending record is still the one it leased;
/// the caller holds the lane.
pub(in crate::gateway::inbound_queue) fn take(candidates: Vec<Candidate>) -> QueueResult<Claimed> {
    let mut claimed = Claimed {
        items: Vec::with_capacity(candidates.len()),
        committed: None,
        discarded: Vec::new(),
    };
    for candidate in candidates {
        let unchanged = read_raw(&candidate.from)?.as_deref() == Some(&candidate.snapshot[..]);
        if !unchanged || fs::rename(&candidate.from, &candidate.item.path).is_err() {
            claimed.discarded.push(candidate.staged);
            continue;
        }
        // Every lease lands in `processing`: one directory sync covers all.
        claimed.committed = Some(candidate.staged.commit()?);
        claimed.items.push(candidate.item);
    }
    Ok(claimed)
}

impl Claimed {
    /// Syncs the claims' directory; run after releasing the lane.
    pub(in crate::gateway::inbound_queue) fn finish(self) -> QueueResult<Vec<ClaimedInboundEvent>> {
        drop(self.discarded);
        if let Some(committed) = self.committed {
            committed.sync()?;
        }
        Ok(self.items)
    }
}

fn lease(owner: &str) -> QueueResult<ProcessingLease> {
    let now = SystemTime::now();
    let claimed: DateTime<Utc> = now.into();
    let expires: DateTime<Utc> = now
        .checked_add(LEASE)
        .ok_or_else(|| {
            InboundQueueError::new(
                InboundQueueCode::InboundQueueTimeInvalid,
                "Invalid queue lease",
            )
        })?
        .into();
    Ok(ProcessingLease {
        claim_id: uuid::Uuid::new_v4().to_string(),
        owner_id: owner.to_owned(),
        claimed_at: claimed.to_rfc3339_opts(SecondsFormat::Millis, true),
        lease_expires_at: expires.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn available(record: &crate::gateway::inbound_queue::QueuedInboundEvent) -> bool {
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

pub(in crate::gateway::inbound_queue) fn recover_stale(
    root: &Path,
    owner: &str,
    active: &HashSet<String>,
) -> QueueResult<usize> {
    ensure_dir(&root.join("pending"))?;
    let mut recovered = 0;
    for name in file_names(&root.join("processing"))? {
        let path = root.join("processing").join(&name);
        let Some(mut record) = read(&path)? else {
            continue;
        };
        if active.contains(&record.queue_id) {
            continue;
        }
        if settled_claim(root, &record)? {
            // A settlement durable before its claimed copy was released.
            let _ = fs::remove_file(&path);
            continue;
        }
        let (expired, dead) = lease_state(&record, &path);
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
                    InboundQueueError::new(
                        InboundQueueCode::InboundQueueEncodeFailed,
                        error.to_string(),
                    )
                    .with_source(error)
                })?,
            );
        }
        atomic_write(&pending, &record)?;
        recovered += 1;
    }
    Ok(recovered)
}

/// Whether a terminal record settles exactly this claimed copy's lease.
fn settled_claim(root: &Path, record: &QueuedInboundEvent) -> QueueResult<bool> {
    let Some(lease) = record.processing.as_ref() else {
        return Ok(false);
    };
    for state in ["processed", "failed"] {
        if read(&record_path(root, state, &record.queue_id))?.is_some_and(|terminal| {
            terminal
                .metadata
                .get("terminalClaimId")
                .and_then(|id| id.as_str())
                == Some(lease.claim_id.as_str())
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the claim's owner process is known to be gone.
fn owner_dead(owner: &str) -> bool {
    use butler_platform::process_control::{Liveness, liveness};
    let Some(pid) = owner
        .split(':')
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    liveness(pid) == Liveness::Gone
}

fn lease_state(
    record: &crate::gateway::inbound_queue::QueuedInboundEvent,
    path: &Path,
) -> (bool, bool) {
    match record.processing.as_ref() {
        Some(lease) => (
            DateTime::parse_from_rfc3339(&lease.lease_expires_at)
                .is_ok_and(|expires| expires.timestamp_millis() <= chrono_now_millis()),
            owner_dead(&lease.owner_id),
        ),
        // Legacy claims can die between rename and lease publication. The
        // file's mtime bounds their ownership just as the normal lease does.
        None => (
            fs::metadata(path)
                .and_then(|meta| meta.modified())
                .is_ok_and(|mtime| {
                    SystemTime::now()
                        .duration_since(mtime)
                        .is_ok_and(|age| age >= LEASE)
                }),
            false,
        ),
    }
}
