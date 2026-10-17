//! Event identity, claim reconciliation, and source idempotent lookup.

use std::{path::Path, time::SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Map, Value, value::RawValue};
use sha2::{Digest, Sha256};

use super::{STATES, io::read, record_path};
use crate::gateway::InboundQueueCode;
use crate::gateway::inbound_queue::{InboundQueueError, QueueResult, QueuedInboundEvent};
use butler_core::json::JsonDocument;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EnvelopeIdentity {
    pub(super) event_id: String,
    pub(super) routing_hints: Option<RoutingHints>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RoutingHints {
    pub(super) app_queue_claim_id: Option<String>,
}

pub(super) fn identity(envelope: &JsonDocument) -> QueueResult<EnvelopeIdentity> {
    let id: EnvelopeIdentity = envelope.read().map_err(|error| {
        InboundQueueError::new(InboundQueueCode::InboundEnvelopeInvalid, error.to_string())
            .with_source(error)
    })?;
    if id.event_id.is_empty() {
        return Err(InboundQueueError::new(
            InboundQueueCode::InboundEnvelopeInvalid,
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

pub(super) fn canonical_id(event_id: &str) -> String {
    format!("idempotent-{}", safe_id(event_id))
}

pub(super) fn reconciliation_id(event_id: &str, claim_id: &str) -> String {
    let digest = Sha256::digest(format!("{event_id}\0{claim_id}").as_bytes());
    format!("idempotent-reconcile-{digest:x}")
}

pub(super) fn find_queue_id(
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

pub(in crate::gateway::inbound_queue) fn find_idempotent(
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

pub(super) fn fresh(
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

pub(super) fn patch_envelope(
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
    JsonDocument::from_encoded(serde_json::to_string(&outer).map_err(encode)?).map_err(|error| {
        InboundQueueError::new(
            InboundQueueCode::InboundQueueEncodeFailed,
            error.to_string(),
        )
        .with_source(error)
    })
}

fn raw_string(value: &str) -> QueueResult<Box<RawValue>> {
    RawValue::from_string(serde_json::to_string(value).map_err(encode)?).map_err(encode)
}

fn encode(error: impl std::error::Error + Send + Sync + 'static) -> InboundQueueError {
    InboundQueueError::new(
        InboundQueueCode::InboundQueueEncodeFailed,
        error.to_string(),
    )
    .with_source(error)
}
