//! Event identity, claim reconciliation, and source idempotent lookup.

use std::{path::Path, time::SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Map, Value, value::RawValue};
use sha2::{Digest, Sha256};

use super::{
    STATES,
    io::{atomic_write, read},
    record_path,
};
use crate::{
    gateway::native_queue::{NativeQueueError, QueueResult, QueuedInboundEvent},
    json::JsonDocument,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeIdentity {
    event_id: String,
    routing_hints: Option<RoutingHints>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutingHints {
    app_queue_claim_id: Option<String>,
}

fn identity(envelope: &JsonDocument) -> QueueResult<EnvelopeIdentity> {
    let id: EnvelopeIdentity = envelope
        .read()
        .map_err(|error| NativeQueueError::new("inbound_envelope_invalid", error.to_string()))?;
    if id.event_id.is_empty() {
        return Err(NativeQueueError::new(
            "inbound_envelope_invalid",
            "Missing event identity",
        ));
    }
    Ok(id)
}

fn safe_id(event_id: &str) -> String {
    let mut value = String::new();
    let mut bad = false;
    for ch in event_id.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            bad = false;
            if value.len() < 120 {
                value.push(ch);
            }
        } else if !bad {
            bad = true;
            if value.len() < 120 {
                value.push('_');
            }
        }
    }
    if value.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        value
    }
}

fn canonical_id(event_id: &str) -> String {
    format!("idempotent-{}", safe_id(event_id))
}

fn reconciliation_id(event_id: &str, claim_id: &str) -> String {
    let digest = Sha256::digest(format!("{event_id}\0{claim_id}").as_bytes());
    format!("idempotent-reconcile-{digest:x}")
}

fn find_queue_id(
    root: &Path,
    queue_id: &str,
) -> QueueResult<Option<(QueuedInboundEvent, &'static str)>> {
    for state in STATES {
        if let Some(record) = read(&record_path(root, state, queue_id))? {
            return Ok(Some((record, state)));
        }
    }
    Ok(None)
}

pub(in crate::gateway::native_queue) fn find_idempotent(
    root: &Path,
    envelope: &JsonDocument,
) -> QueueResult<Option<QueuedInboundEvent>> {
    let id = identity(envelope)?;
    let Some((canonical, _)) = find_queue_id(root, &canonical_id(&id.event_id))? else {
        return Ok(None);
    };
    let next_claim = id.routing_hints.and_then(|hints| hints.app_queue_claim_id);
    let prior_claim = identity(&canonical.envelope)?
        .routing_hints
        .and_then(|hints| hints.app_queue_claim_id);
    if let Some(claim) = next_claim
        .as_deref()
        .filter(|claim| Some(*claim) != prior_claim.as_deref())
    {
        return Ok(
            find_queue_id(root, &reconciliation_id(&id.event_id, claim))?.map(|(record, _)| record),
        );
    }
    Ok(Some(canonical))
}

pub(in crate::gateway::native_queue) fn enqueue_idempotent(
    root: &Path,
    envelope: JsonDocument,
    metadata: Map<String, Value>,
) -> QueueResult<QueuedInboundEvent> {
    let id = identity(&envelope)?;
    let claim = id.routing_hints.and_then(|hints| hints.app_queue_claim_id);
    let queue_id = canonical_id(&id.event_id);
    if let Some((mut existing, state)) = find_queue_id(root, &queue_id)? {
        let old_claim = identity(&existing.envelope)?
            .routing_hints
            .and_then(|hints| hints.app_queue_claim_id);
        if let Some(next_claim) = claim
            .as_deref()
            .filter(|claim| Some(*claim) != old_claim.as_deref())
        {
            if state == "pending" {
                existing.envelope =
                    patch_envelope(&existing.envelope, None, Some(next_claim), None)?;
                atomic_write(&record_path(root, "pending", &queue_id), &existing)?;
                return Ok(existing);
            }
            let new_id = reconciliation_id(&id.event_id, next_claim);
            if let Some((record, _)) = find_queue_id(root, &new_id)? {
                return Ok(record);
            }
            let replacement_event = format!("{}:claim:{}", id.event_id, next_claim);
            let patched = patch_envelope(
                &envelope,
                Some(&replacement_event),
                Some(next_claim),
                Some(&id.event_id),
            )?;
            let mut record = fresh(new_id, patched, metadata);
            record
                .metadata
                .insert("reconciliationOfEventId".into(), id.event_id.into());
            atomic_write(&record_path(root, "pending", &record.queue_id), &record)?;
            return Ok(record);
        }
        return Ok(existing);
    }
    let record = fresh(queue_id, envelope, metadata);
    atomic_write(&record_path(root, "pending", &record.queue_id), &record)?;
    Ok(record)
}

fn fresh(
    queue_id: String,
    envelope: JsonDocument,
    metadata: Map<String, Value>,
) -> QueuedInboundEvent {
    let now: DateTime<Utc> = SystemTime::now().into();
    QueuedInboundEvent {
        version: 1,
        queue_id,
        envelope,
        enqueued_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        attempts: 0,
        metadata,
        processing: None,
        extra: Map::new(),
    }
}

fn patch_envelope(
    envelope: &JsonDocument,
    event_id: Option<&str>,
    claim: Option<&str>,
    canonical: Option<&str>,
) -> QueueResult<JsonDocument> {
    let mut outer: IndexMap<String, Box<RawValue>> =
        serde_json::from_str(envelope.as_str()).map_err(encode)?;
    if let Some(event_id) = event_id {
        outer.insert("eventId".into(), raw_string(event_id)?);
    }
    let hints = outer
        .get("routingHints")
        .map(|raw| raw.get())
        .unwrap_or("{}");
    let mut hints: IndexMap<String, Box<RawValue>> = serde_json::from_str(hints).map_err(encode)?;
    if let Some(claim) = claim {
        hints.insert("appQueueClaimId".into(), raw_string(claim)?);
    }
    if let Some(canonical) = canonical {
        // A retry occurrence already carries the original App event identity.
        // Reconciliation may change its queue claim, but not the BTCC identity.
        if !hints.contains_key("canonicalEventId") {
            hints.insert("canonicalEventId".into(), raw_string(canonical)?);
        }
    }
    outer.insert(
        "routingHints".into(),
        RawValue::from_string(serde_json::to_string(&hints).map_err(encode)?).map_err(encode)?,
    );
    JsonDocument::from_encoded(serde_json::to_string(&outer).map_err(encode)?)
        .map_err(|error| NativeQueueError::new("inbound_queue_encode_failed", error.to_string()))
}

fn raw_string(value: &str) -> QueueResult<Box<RawValue>> {
    RawValue::from_string(serde_json::to_string(value).map_err(encode)?).map_err(encode)
}

fn encode(error: impl std::fmt::Display) -> NativeQueueError {
    NativeQueueError::new("inbound_queue_encode_failed", error.to_string())
}
