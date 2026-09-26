//! The App reservation admits through the existing durable native queue.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    gateway::{
        AppNativeIngress, ApplicationFuture, GatewayApplicationError, NativeAppCancellation,
        NativeAppTurn, NativeEnqueueReceipt, NativeInboundQueue,
    },
    json::JsonDocument,
};

pub(crate) struct NativeAppIngress {
    queue: Arc<NativeInboundQueue>,
}

impl NativeAppIngress {
    pub(crate) fn new(queue: Arc<NativeInboundQueue>) -> Self {
        Self { queue }
    }
}

impl AppNativeIngress for NativeAppIngress {
    fn enqueue(&self, turn: NativeAppTurn) -> ApplicationFuture<NativeEnqueueReceipt> {
        let queue = self.queue.clone();
        Box::pin(async move {
            let document = envelope(turn)?;
            let record = queue
                .enqueue_idempotent(document)
                .map_err(|_| GatewayApplicationError::Internal)?;
            Ok(NativeEnqueueReceipt {
                queue_id: record.queue_id,
            })
        })
    }

    fn find(&self, turn: NativeAppTurn) -> ApplicationFuture<Option<NativeEnqueueReceipt>> {
        let queue = self.queue.clone();
        Box::pin(async move {
            let document = envelope(turn)?;
            queue
                .find_idempotent(&document)
                .map(|record| {
                    record.map(|item| NativeEnqueueReceipt {
                        queue_id: item.queue_id,
                    })
                })
                .map_err(|_| GatewayApplicationError::Internal)
        })
    }

    fn enqueue_cancel(
        &self,
        cancel: NativeAppCancellation,
    ) -> ApplicationFuture<NativeEnqueueReceipt> {
        let queue = self.queue.clone();
        Box::pin(async move {
            let mut value = json!({
                "eventId":format!("app-cancel:{}",cancel.request_id),
                "transport":"app","accountId":"local",
                "peer":{"kind":"dm","id":cancel.chat_id},
                "sender":{"id":"app-user","displayName":"User"},
                "message":{"id":format!("app-cancel-message:{}",cancel.request_id),"text":"","timestamp":cancel.requested_at},
                "routingHints":{"sessionId":cancel.session_id,"turnId":cancel.turn_id},
                "control":{"kind":"cancel_turn","requestId":cancel.request_id,"turnId":cancel.turn_id,"requestedAt":cancel.requested_at}
            });
            if let Some(claim) = cancel.app_queue_claim_id {
                value["routingHints"]["appQueueClaimId"] = claim.into();
            }
            let document =
                JsonDocument::from_value(&value).map_err(|_| GatewayApplicationError::Internal)?;
            let record = queue
                .enqueue_idempotent(document)
                .map_err(|_| GatewayApplicationError::Internal)?;
            Ok(NativeEnqueueReceipt {
                queue_id: record.queue_id,
            })
        })
    }
}

fn envelope(turn: NativeAppTurn) -> Result<JsonDocument, GatewayApplicationError> {
    let canonical_event_id = format!("app:{}", turn.message_id);
    let event_id = if turn.turn_attempt > 1 {
        format!(
            "app-retry:{}:{}:{}",
            turn.message_id.len(),
            turn.message_id,
            turn.turn_attempt
        )
    } else {
        canonical_event_id.clone()
    };
    let mut value = json!({
        "eventId":event_id,
        "transport":"app",
        "accountId":turn.account_id,
        "peer":{"kind":turn.peer_kind,"id":turn.chat_id},
        "sender":{"id":turn.sender_id,"displayName":turn.sender_display_name},
        "message":{
            "id":turn.message_id,
            "text":turn.text,
            "attachments":turn.attachments,
            "timestamp":turn.timestamp,
        },
        "routingHints":{
            "sessionId":turn.session_id,
            "turnId":turn.turn_id,
        },
        "executionControls":turn.execution_controls,
        "appTurnContext":turn.app_turn_context,
        "raw":{"source":turn.raw_source},
    });
    if turn.turn_attempt != 0 {
        value["routingHints"]["turnAttempt"] = Value::from(turn.turn_attempt);
    }
    if turn.turn_attempt > 1 {
        value["routingHints"]["canonicalEventId"] = canonical_event_id.into();
    }
    if let Some(project) = turn.project_id {
        value["routingHints"]["projectId"] = project.into();
    }
    if let Some(claim) = turn.app_queue_claim_id {
        value["routingHints"]["appQueueClaimId"] = claim.into();
    }
    if let Some(image) = turn.image_admission {
        value["message"]["imageAdmission"] = image;
    }
    JsonDocument::from_value(&value).map_err(|_| GatewayApplicationError::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Duration};

    #[tokio::test]
    async fn accepted_app_turn_wakes_the_dispatcher_after_queue_admission() {
        let root =
            std::env::temp_dir().join(format!("butler-app-ingress-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let queue = Arc::new(NativeInboundQueue::new(root.clone()));
        let ingress = NativeAppIngress::new(queue.clone());
        let receipt = ingress
            .enqueue(NativeAppTurn {
                chat_id: "chat".into(),
                message_id: "message".into(),
                turn_id: "turn".into(),
                turn_attempt: 1,
                text: "hello".into(),
                timestamp: "2026-09-25T00:00:00Z".into(),
                session_id: "session".into(),
                account_id: "local".into(),
                peer_kind: "dm".into(),
                sender_id: "user".into(),
                sender_display_name: "User".into(),
                project_id: None,
                execution_controls: json!({}),
                app_queue_claim_id: Some("claim".into()),
                app_turn_context: json!({}),
                attachments: json!([]),
                image_admission: None,
                raw_source: "app".into(),
            })
            .await
            .expect("durable App queue admission");

        assert!(!receipt.queue_id.is_empty());
        tokio::time::timeout(Duration::from_secs(1), queue.wait_for_enqueue())
            .await
            .expect("App admission wakes the native dispatcher");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retry_occurrence_keeps_the_original_btcc_event_identity() {
        let turn = NativeAppTurn {
            chat_id: "chat".into(),
            message_id: "message".into(),
            turn_id: "turn".into(),
            turn_attempt: 1,
            text: "hello".into(),
            timestamp: "2026-09-25T00:00:00Z".into(),
            session_id: "session".into(),
            account_id: "local".into(),
            peer_kind: "dm".into(),
            sender_id: "user".into(),
            sender_display_name: "User".into(),
            project_id: None,
            execution_controls: json!({}),
            app_queue_claim_id: Some("claim".into()),
            app_turn_context: json!({}),
            attachments: json!([]),
            image_admission: None,
            raw_source: "app".into(),
        };
        let first: Value = envelope(turn.clone()).unwrap().read().unwrap();
        let retry: Value = envelope(NativeAppTurn {
            turn_attempt: 2,
            ..turn.clone()
        })
        .unwrap()
        .read()
        .unwrap();
        assert_eq!(first["eventId"], "app:message");
        assert_eq!(retry["eventId"], "app-retry:7:message:2");
        assert_eq!(retry["routingHints"]["canonicalEventId"], first["eventId"]);
        assert_eq!(
            retry["routingHints"]["turnId"],
            first["routingHints"]["turnId"]
        );
        assert_eq!(retry["routingHints"]["turnAttempt"], 2);
        let colliding_first: Value = envelope(NativeAppTurn {
            message_id: "message:attempt:2".into(),
            turn_attempt: 1,
            ..turn
        })
        .unwrap()
        .read()
        .unwrap();
        assert_ne!(retry["eventId"], colliding_first["eventId"]);
    }
}
