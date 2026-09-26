use super::*;
use std::{fs, time::Duration};

#[tokio::test]
async fn accepted_app_turn_wakes_the_dispatcher_after_queue_admission() {
    let root = std::env::temp_dir().join(format!("butler-app-ingress-{}", uuid::Uuid::new_v4()));
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
