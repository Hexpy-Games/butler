//! App progress publication from committed BTCC facts through the native transcript.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::btcc::{
    BtccError, CommittedProgressEvent, EventVisibility, PeerKind, StorageProgressPublication,
};
use crate::gateway::{NativeTranscriptWriter, normalize_committed_turn_event};

const PAGE_SIZE: usize = 32;

pub(crate) struct NativeProgressPublisher {
    repository: StorageProgressPublication,
    writer: Arc<NativeTranscriptWriter>,
}

pub(crate) struct ProgressPublicationSummary {
    pub attempted: usize,
    pub published: usize,
}

impl NativeProgressPublisher {
    pub(crate) fn new(
        repository: StorageProgressPublication,
        writer: Arc<NativeTranscriptWriter>,
    ) -> Self {
        Self { repository, writer }
    }

    /// Each page releases its hydrated events before the next SQLite read.
    /// Failures remain pending; the keyset lets later events proceed this pass.
    pub(crate) async fn reconcile(&self) -> Result<ProgressPublicationSummary, BtccError> {
        let mut summary = ProgressPublicationSummary {
            attempted: 0,
            published: 0,
        };
        let mut after = None;
        loop {
            let page = self
                .repository
                .pending_page(after.clone(), PAGE_SIZE)
                .await
                .map_err(BtccError::from)?;
            if page.is_empty() {
                break;
            }
            let page_len = page.len();
            for event in page {
                after = Some((event.session_sequence, event.event_id.clone()));
                summary.attempted += 1;
                if self.publish(&event).await.is_ok()
                    && self
                        .repository
                        .mark_published(&event.event_id)
                        .await
                        .is_ok()
                {
                    summary.published += 1;
                }
            }
            if page_len < PAGE_SIZE {
                break;
            }
        }
        Ok(summary)
    }

    async fn publish(&self, event: &CommittedProgressEvent) -> Result<(), BtccError> {
        let destination = &event.destination;
        if destination.transport != "app" {
            return Err(BtccError::relayed(
                "progress_transport_unavailable",
                "No enabled progress publisher for this transport",
            ));
        }
        let visibility = match event.event.visibility.unwrap_or(EventVisibility::Public) {
            EventVisibility::Public => "public",
            EventVisibility::Internal => "internal",
        };
        let payload = normalize_committed_turn_event(
            &event.event.kind,
            visibility,
            event.event.payload.as_ref(),
        )
        .map_err(|_| {
            BtccError::relayed(
                "progress_event_projection_failed",
                "Progress event is invalid",
            )
        })?;
        let mut public_event = json!({
            "id":event.event_id,
            "kind":event.event.kind,
            "visibility":visibility,
            "sessionSequence":event.session_sequence,
            "turnSequence":event.turn_sequence,
            "createdAt":event.event.created_at,
            "payload":payload,
        });
        // The source projection omits these identities from the outbound event
        // object; the enclosing action owns its Turn/session routing fields.
        if public_event["createdAt"].is_null() {
            crate::json::object_mut(&mut public_event).remove("createdAt");
        }
        let peer = if destination.peer.kind == PeerKind::Thread {
            json!({
                "kind":"thread",
                "id":destination.peer.parent_id.as_deref().unwrap_or(&destination.peer.id),
                "threadId":destination.peer.id,
            })
        } else {
            json!({"kind":destination.peer.kind,"id":destination.peer.id})
        };
        let mut action_metadata = json!({
            "kind":"turn_event",
            "turnId":event.turn_id,
            "event":public_event,
            "source":"gateway/native-butler/projection-and-lifecycle.ts#turn-event",
        });
        if let Some(claim) = destination
            .app_queue_claim_id
            .as_ref()
            .filter(|claim| !claim.is_empty())
        {
            action_metadata["appQueueClaimId"] = Value::String(claim.clone());
        }
        let action = json!({
            "actionId":event.action_id,
            "transport":"app",
            "accountId":destination.account_id,
            "peer":peer,
            "message":{"text":"","replyToMessageId":destination.reply_to_message_id},
            "metadata":action_metadata,
        });
        let delivery = json!({
            "ok":true,
            "transportMessageId":format!("app:{}",event.action_id),
        });
        let metadata = json!({
            "source":"gateway/native-butler/projection-and-lifecycle.ts#progress",
            "kind":"turn_event",
            "turnId":event.turn_id,
            "eventId":event.event_id,
            "actionId":event.action_id,
            "sessionSequence":event.session_sequence,
            "turnSequence":event.turn_sequence,
        });
        self.writer
            .append_outbound(event.session_id.clone(), action, delivery, metadata)
            .await
            .map_err(|_| BtccError::relayed("progress_delivery_failed", "Progress delivery failed"))
    }
}
