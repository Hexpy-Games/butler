//! Shared native queue adapter for BTCC child dispatch and recovery facts.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    btcc::{BtccError, InterruptedSubsessionEvent, SubsessionChildQueue, SubsessionEnqueue},
    gateway::NativeInboundQueue,
    json::JsonDocument,
};

pub(crate) struct NativeSubsessionQueue(pub(crate) Arc<NativeInboundQueue>);

impl SubsessionChildQueue for NativeSubsessionQueue {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError> {
        let document = JsonDocument::from_value(&input.envelope).map_err(|_| invalid())?;
        self.0
            .enqueue_idempotent_with_metadata(document, input.metadata)
            .map(|_| ())
            .map_err(queue_error)
    }

    fn interrupted_event(
        &self,
        event_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError> {
        let lookup =
            JsonDocument::from_value(&json!({"eventId":event_id})).map_err(|_| invalid())?;
        let Some(record) = self.0.find_idempotent(&lookup).map_err(queue_error)? else {
            return Ok(None);
        };
        let parked = record
            .metadata
            .get("recoveredFromRuntimeInterruption")
            .and_then(Value::as_bool)
            == Some(true)
            && record
                .metadata
                .get("sameLogicalTurnContinuation")
                .and_then(Value::as_bool)
                == Some(true);
        let stale = record
            .metadata
            .get("recoveredFromProcessing")
            .and_then(Value::as_bool)
            == Some(true)
            && matches!(
                record
                    .metadata
                    .get("recoveryReason")
                    .and_then(Value::as_str),
                Some("processing_owner_dead" | "processing_lease_expired")
            );
        if !parked && !stale {
            return Ok(None);
        }
        let recovery_id = record
            .metadata
            .get("interruptedClaimId")
            .and_then(Value::as_str)
            .or_else(|| {
                record
                    .metadata
                    .get("previousProcessing")
                    .and_then(|value| value.get("claimId"))
                    .and_then(Value::as_str)
            })
            .filter(|value| !value.is_empty());
        let envelope: Value = record.envelope.read().map_err(|_| invalid())?;
        let matches = envelope
            .pointer("/routingHints/sessionId")
            .and_then(Value::as_str)
            == Some(session_id)
            && envelope
                .pointer("/routingHints/turnId")
                .and_then(Value::as_str)
                == Some(turn_id)
            && envelope.get("eventId").and_then(Value::as_str) == Some(event_id);
        if !matches {
            return Ok(None);
        }
        let Some((message_id, message, recovery_id)) = envelope
            .pointer("/message/id")
            .and_then(Value::as_str)
            .zip(envelope.pointer("/message/text").and_then(Value::as_str))
            .zip(recovery_id)
            .map(|((id, message), recovery)| (id, message, recovery))
        else {
            return Ok(None);
        };
        Ok(Some(InterruptedSubsessionEvent {
            event_id: event_id.into(),
            message_id: message_id.into(),
            message: message.into(),
            recovery_id: recovery_id.into(),
        }))
    }
}

fn invalid() -> BtccError {
    BtccError::relayed(
        "subsession_dispatch_intent_invalid",
        "Subsession dispatch intent is invalid",
    )
}

fn queue_error(error: crate::gateway::NativeQueueError) -> BtccError {
    BtccError::relayed(error.code, error.message)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Map, Value, json};

    use super::{NativeSubsessionQueue, SubsessionChildQueue, SubsessionEnqueue};
    use crate::{gateway::NativeInboundQueue, json::JsonDocument};

    #[test]
    fn child_cancel_outbox_preserves_parent_turn_provenance_outside_envelope() {
        let root =
            std::env::temp_dir().join(format!("butler-subsession-outbox-{}", uuid::Uuid::new_v4()));
        let queue = Arc::new(NativeInboundQueue::new(&root.clone()));
        let adapter = NativeSubsessionQueue(queue.clone());
        let envelope = json!({
            "eventId":"subsession-cancel:request-1",
            "control":{"kind":"cancel_turn","requestId":"request-1"}
        });
        let metadata = Map::from_iter([
            ("source".into(), json!("btcc-steward-control")),
            ("relation_id".into(), json!("relation-1")),
            ("source_parent_turn_id".into(), json!("parent-turn-1")),
        ]);
        adapter
            .enqueue(SubsessionEnqueue {
                envelope: envelope.clone(),
                metadata: metadata.clone(),
            })
            .unwrap();

        let lookup = JsonDocument::from_value(&envelope).unwrap();
        let stored = NativeInboundQueue::new(&root.clone())
            .find_idempotent(&lookup)
            .unwrap()
            .unwrap();
        assert_eq!(stored.metadata, metadata);
        assert_eq!(stored.envelope.read::<Value>().unwrap(), envelope);
        assert!(!stored.envelope.as_str().contains("source_parent_turn_id"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
