use std::fs;
use std::time::Duration;

use serde_json::json;

use super::*;

#[tokio::test]
async fn durable_enqueue_leaves_a_wake_for_the_dispatcher() {
    let root = std::env::temp_dir().join(format!("butler-native-queue-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let queue = NativeInboundQueue::new(&root.clone());

    queue
        .enqueue_idempotent(JsonDocument::from_value(&json!({"eventId":"wake-me"})).unwrap())
        .unwrap();

    tokio::time::timeout(Duration::from_secs(1), queue.wait_for_enqueue())
        .await
        .expect("enqueue wake is available to a dispatcher that starts waiting later");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reclaimed_app_claim_reconciles_without_losing_original_json_or_terminal_history() {
    let root = std::env::temp_dir().join(format!("butler-native-queue-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let queue = NativeInboundQueue::new(&root.clone());
    let first = JsonDocument::from_encoded(
        r#"{"eventId":"app:m1","routingHints":{"appQueueClaimId":"claim-1"},"message":{"text":"\ud83d"}}"#.into(),
    ).unwrap();
    let admitted = queue.enqueue_idempotent(first).unwrap();
    let claimed = queue.claim_eligible(1, |_| true).unwrap().pop().unwrap();
    assert_eq!(claimed.record.queue_id, admitted.queue_id);

    let next = JsonDocument::from_encoded(
        r#"{"eventId":"app:m1","routingHints":{"appQueueClaimId":"claim-2"},"message":{"text":"\ud83d"}}"#.into(),
    ).unwrap();
    let reconciled = queue.enqueue_idempotent(next.clone()).unwrap();
    assert_ne!(reconciled.queue_id, admitted.queue_id);
    assert!(
        reconciled
            .envelope
            .as_str()
            .contains(r#""canonicalEventId":"app:m1""#)
    );
    assert!(reconciled.envelope.as_str().contains(r#""text":"\ud83d""#));
    assert_eq!(
        queue.find_idempotent(&next).unwrap().unwrap().queue_id,
        reconciled.queue_id
    );
    assert!(queue.complete(&claimed, json!({"delivered":1})).unwrap());

    let reopened = NativeInboundQueue::new(&root.clone());
    let replay = reopened.claim_eligible(1, |_| true).unwrap().pop().unwrap();
    assert_eq!(replay.record.queue_id, reconciled.queue_id);
    assert!(reopened.complete(&replay, json!({"delivered":1})).unwrap());
    assert!(
        root.join("runtime/inbound-events/processed")
            .join(format!("{}.json", admitted.queue_id))
            .exists()
    );
    assert!(
        root.join("runtime/inbound-events/processed")
            .join(format!("{}.json", reconciled.queue_id))
            .exists()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retry_claim_reconciliation_preserves_original_btcc_identity() {
    let root = std::env::temp_dir().join(format!("butler-native-queue-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let queue = NativeInboundQueue::new(&root.clone());
    let first = JsonDocument::from_encoded(
        r#"{"eventId":"app-retry:2:m1:2","routingHints":{"appQueueClaimId":"claim-1","canonicalEventId":"app:m1","turnAttempt":2}}"#.into(),
    ).unwrap();
    let admitted = queue.enqueue_idempotent(first).unwrap();
    let claimed = queue.claim_eligible(1, |_| true).unwrap().pop().unwrap();
    let next = JsonDocument::from_encoded(
        r#"{"eventId":"app-retry:2:m1:2","routingHints":{"appQueueClaimId":"claim-2","canonicalEventId":"app:m1","turnAttempt":2}}"#.into(),
    ).unwrap();
    let reconciled = queue.enqueue_idempotent(next.clone()).unwrap();
    assert_ne!(reconciled.queue_id, admitted.queue_id);
    let envelope: serde_json::Value = reconciled.envelope.read().unwrap();
    assert_eq!(envelope["routingHints"]["canonicalEventId"], "app:m1");
    assert_eq!(envelope["routingHints"]["turnAttempt"], 2);
    assert_eq!(
        queue.find_idempotent(&next).unwrap().unwrap().queue_id,
        reconciled.queue_id
    );
    assert!(queue.complete(&claimed, json!({"delivered":1})).unwrap());
    fs::remove_dir_all(root).unwrap();
}
