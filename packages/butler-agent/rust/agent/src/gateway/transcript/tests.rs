use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use super::*;

struct Clock(AtomicU64);
impl AppIdentityClock for Clock {
    fn new_uuid(&self) -> String {
        format!("event-{}", self.0.fetch_add(1, Ordering::Relaxed))
    }
    fn now_iso(&self) -> String {
        "2026-09-19T00:00:00.000Z".into()
    }
    fn iso_after_millis(&self, _: u64) -> String {
        self.now_iso()
    }
}

#[tokio::test]
async fn outbound_delivery_and_replay_claim_append_source_transcript_events() {
    let root = std::env::temp_dir().join(format!("butler-transcript-{}", uuid::Uuid::new_v4()));
    let writer =
        NativeTranscriptWriter::new(root.clone(), Arc::new(Clock(AtomicU64::new(1)))).unwrap();
    let session = "butler/app-general".to_owned();
    writer
        .append_lifecycle(
            session.clone(),
            "butler".into(),
            "active".into(),
            Some("native-butler-bootstrap".into()),
            json!({"projectId":null,"workspacePath":"/isolated"}),
        )
        .await
        .unwrap();
    let action = json!({
        "actionId":"action-1", "transport":"app", "accountId":"local",
        "peer":{"kind":"dm","id":"chat-1"},
        "message":{"text":"Visible answer"},
        "metadata":{"appQueueClaimId":"claim-1","appQueueClaimProvenance":"matching_app_target"},
    });
    let delivery = json!({"ok":true,"transportMessageId":"app:action-1"});
    let metadata = json!({"source":"transport/delivery-guard.ts","attempts":1});
    writer
        .append_outbound(
            session.clone(),
            action.clone(),
            delivery.clone(),
            metadata.clone(),
        )
        .await
        .unwrap();
    writer
        .append_outbound(
            session,
            action,
            delivery,
            json!({"source":"transport/delivery-guard.ts","attempts":0,"duplicate":true}),
        )
        .await
        .unwrap();
    writer.close().await.unwrap();
    let text = std::fs::read_to_string(root.join("transcripts/butler_app-general.jsonl")).unwrap();
    let events: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), 5);
    assert_eq!(events[0]["kind"], "session_status");
    assert_eq!(events[0]["payload"]["reason"], "native-butler-bootstrap");
    assert_eq!(events[1]["kind"], "outbound");
    assert_eq!(events[1]["payload"]["message"]["text"], "Visible answer");
    assert_eq!(events[2]["kind"], "delivery");
    assert_eq!(events[2]["payload"]["ok"], true);
    assert_eq!(events[2]["payload"]["transportMessageId"], "app:action-1");
    assert_eq!(events[3]["payload"]["actionId"], "action-1");
    assert_eq!(events[4]["metadata"]["duplicate"], true);
    std::fs::remove_dir_all(root).unwrap();
}
