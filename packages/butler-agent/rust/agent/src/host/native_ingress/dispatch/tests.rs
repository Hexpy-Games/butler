
use std::{collections::HashSet, fs};

use serde_json::json;

use super::eligible_for_claim;
use crate::{gateway::NativeInboundQueue, json::JsonDocument};

#[test]
fn waiting_source_session_admits_control_then_released_ordinary_event() {
    let root = std::env::temp_dir().join(format!(
        "butler-native-ingress-waiting-{}",
        uuid::Uuid::new_v4()
    ));
    let queue = NativeInboundQueue::new(root.clone());
    let ordinary = queue
        .enqueue_idempotent(JsonDocument::from_value(&event("ordinary-1", None)).unwrap())
        .unwrap();
    let control = queue
        .enqueue_idempotent(
            JsonDocument::from_value(&event(
                "control-1",
                Some(json!({
                    "kind":"resume_turn",
                    "requestId":"request-1",
                    "turnId":"turn-1"
                })),
            ))
            .unwrap(),
        )
        .unwrap();

    let mut waiting = HashSet::from(["source-session".to_owned()]);
    let active = HashSet::new();
    let mut batch = HashSet::new();
    let claimed = queue
        .claim_eligible(2, |record| {
            eligible_for_claim(record, &waiting, &active, &mut batch)
        })
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].record.queue_id, control.queue_id);
    assert!(
        queue
            .complete(&claimed[0], json!({"handled":true}))
            .unwrap()
    );

    waiting.clear();
    let mut batch = HashSet::new();
    let released = queue
        .claim_eligible(2, |record| {
            eligible_for_claim(record, &waiting, &active, &mut batch)
        })
        .unwrap();
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].record.queue_id, ordinary.queue_id);
    assert!(
        queue
            .complete(&released[0], json!({"handled":true}))
            .unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}

fn event(event_id: &str, control: Option<serde_json::Value>) -> serde_json::Value {
    json!({
        "eventId":event_id,
        "transport":"app",
        "accountId":"local",
        "peer":{"kind":"dm","id":"peer-1"},
        "sender":{"id":"user-1"},
        "message":{"id":event_id,"text":"hello","timestamp":"2026-09-25T00:00:00.000Z"},
        "routingHints":{"sessionId":"source-session"},
        "control":control
    })
}
