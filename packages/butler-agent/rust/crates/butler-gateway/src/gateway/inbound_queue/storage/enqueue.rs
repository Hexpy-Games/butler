//! Idempotent enqueue. The record is staged without the lane and renamed into
//! place under it only while the identity state it was planned from holds, so
//! the identity check and the rename stay one atomic step.

use std::path::Path;

use serde_json::{Map, Value};

use super::{
    identity::{canonical_id, find_queue_id, fresh, identity, patch_envelope, reconciliation_id},
    io::{Committed, ENQUEUE, Staged, stage},
    record_path,
};
use crate::gateway::InboundQueueCode;
use crate::gateway::inbound_queue::{InboundQueueError, QueueResult, QueuedInboundEvent};
use butler_core::json::JsonDocument;

/// What one enqueue changes, and the identity state the decision read.
enum Plan {
    Found(QueuedInboundEvent),
    Write {
        record: QueuedInboundEvent,
        basis: Option<String>,
    },
}

/// The outcome of planning without the lane.
pub(in crate::gateway::inbound_queue) enum Prepared {
    /// The record already in the queue; nothing is published.
    Found(Box<QueuedInboundEvent>),
    /// A record to publish, already staged.
    Staged(Box<StagedEnqueue>),
}

pub(in crate::gateway::inbound_queue) struct StagedEnqueue {
    envelope: JsonDocument,
    metadata: Map<String, Value>,
    record: QueuedInboundEvent,
    basis: Option<String>,
    staged: Staged,
    durable: bool,
}

/// The enqueue's record, visible to readers; durable once [`Enqueued::finish`] returns.
pub(in crate::gateway::inbound_queue) struct Enqueued {
    record: QueuedInboundEvent,
    committed: Option<Committed>,
    _discarded: Option<Staged>,
}

/// Plans and stages without the lane. Records move between state folders
/// but never leave all of them while the queue runs, so a record found here
/// is final; an absent or changing identity is decided again under the lane.
pub(in crate::gateway::inbound_queue) fn prepare(
    root: &Path,
    envelope: JsonDocument,
    metadata: Map<String, Value>,
    durable: bool,
) -> QueueResult<Prepared> {
    let (record, basis) = match plan(root, &envelope, &metadata)? {
        Plan::Found(record) => return Ok(Prepared::Found(Box::new(record))),
        Plan::Write { record, basis } => (record, basis),
    };
    let path = record_path(root, "pending", &record.queue_id);
    let staged = stage(&path, &record, durable, ENQUEUE)?;
    Ok(Prepared::Staged(Box::new(StagedEnqueue {
        envelope,
        metadata,
        record,
        basis,
        staged,
        durable,
    })))
}

/// Publishes a staged enqueue; the caller holds the lane. A plan another
/// writer changed meanwhile is replaced by the current one.
pub(in crate::gateway::inbound_queue) fn commit(
    root: &Path,
    prepared: Box<StagedEnqueue>,
) -> QueueResult<Enqueued> {
    let StagedEnqueue {
        envelope,
        metadata,
        record,
        basis,
        staged,
        durable,
    } = *prepared;
    match plan(root, &envelope, &metadata)? {
        Plan::Write {
            record: current,
            basis: now,
        } if now == basis && current.queue_id == record.queue_id => Ok(Enqueued {
            record,
            committed: Some(staged.commit()?),
            _discarded: None,
        }),
        Plan::Found(existing) => Ok(Enqueued {
            record: existing,
            committed: None,
            _discarded: Some(staged),
        }),
        // Rare: another writer changed this identity after planning.
        Plan::Write {
            record: current, ..
        } => {
            let path = record_path(root, "pending", &current.queue_id);
            let committed = stage(&path, &current, durable, ENQUEUE)?.commit()?;
            Ok(Enqueued {
                record: current,
                committed: Some(committed),
                _discarded: Some(staged),
            })
        }
    }
}

impl Enqueued {
    /// Syncs the published record's directory; run after releasing the lane.
    pub(in crate::gateway::inbound_queue) fn finish(self) -> QueueResult<QueuedInboundEvent> {
        if let Some(committed) = self.committed {
            committed.sync()?;
        }
        Ok(self.record)
    }
}

fn plan(root: &Path, envelope: &JsonDocument, metadata: &Map<String, Value>) -> QueueResult<Plan> {
    let id = identity(envelope)?;
    let claim = id.routing_hints.and_then(|hints| hints.app_queue_claim_id);
    let queue_id = canonical_id(&id.event_id);
    let Some((mut existing, state)) = find_queue_id(root, &queue_id)? else {
        let record = fresh(queue_id, envelope.clone(), metadata.clone());
        return Ok(Plan::Write {
            record,
            basis: None,
        });
    };
    let old_claim = identity(&existing.envelope)?
        .routing_hints
        .and_then(|hints| hints.app_queue_claim_id);
    let Some(next_claim) = claim
        .as_deref()
        .filter(|claim| Some(*claim) != old_claim.as_deref())
    else {
        return Ok(Plan::Found(existing));
    };
    let basis = Some(basis_of(state, &existing)?);
    if state == "pending" {
        existing.envelope = patch_envelope(&existing.envelope, None, Some(next_claim), None)?;
        return Ok(Plan::Write {
            record: existing,
            basis,
        });
    }
    let new_id = reconciliation_id(&id.event_id, next_claim);
    if let Some((record, _)) = find_queue_id(root, &new_id)? {
        return Ok(Plan::Found(record));
    }
    let replacement_event = format!("{}:claim:{}", id.event_id, next_claim);
    let patched = patch_envelope(
        envelope,
        Some(&replacement_event),
        Some(next_claim),
        Some(&id.event_id),
    )?;
    let mut record = fresh(new_id, patched, metadata.clone());
    record
        .metadata
        .insert("reconciliationOfEventId".into(), id.event_id.into());
    Ok(Plan::Write { record, basis })
}

fn basis_of(state: &str, record: &QueuedInboundEvent) -> QueueResult<String> {
    let encoded = serde_json::to_string(record).map_err(|error| {
        InboundQueueError::new(
            InboundQueueCode::InboundQueueEncodeFailed,
            error.to_string(),
        )
        .with_source(error)
    })?;
    Ok(format!("{state}\n{encoded}"))
}
