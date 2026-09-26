use std::fs;

use serde_json::{Value, json};

use super::*;
use crate::{
    btcc::{AlreadyDeliveredOutcome, ArtifactKind, DeliveredOutcome, FinalArtifact, TurnOutcome},
    gateway::NativeInboundQueue,
    json::JsonDocument,
    workspace::{SessionLifecycleState, SessionRole},
};

#[test]
fn app_final_projects_bounded_rich_result_then_source_ordered_cancellation() {
    let root = std::env::temp_dir().join(format!("butler-ingress-rich-{}", uuid::Uuid::new_v4()));
    let queue = NativeInboundQueue::new(root.clone());
    let binding = binding();
    let (item, envelope) = claimed(&queue, "normal", None);
    let artifact = FinalArtifact {
        id: "artifact-id".into(),
        kind: ArtifactKind::Report,
        title: "Report".into(),
        safe_path_label: "report.md".into(),
        mime_type: Some("text/markdown".into()),
        size_bytes: Some(28),
        created_at: None,
    };
    let files = std::iter::once(json!({"path":"invalid"}))
        .chain((0..41).map(|index| json!({"path":format!("file-{index}"),"lines":[]})))
        .collect();
    let delivered = TurnOutcome {
        result: TurnOutcomeKind::Delivered(Box::new(DeliveredOutcome {
            turn_id: "turn-1".into(),
            message_id: "canonical-1".into(),
            content: "Done".into(),
            work_status: None,
            accepted_work_result: None,
            runtime_failure: None,
            execution_outcome: None,
            artifacts: vec![artifact.clone(); 13],
            changed_files: files,
            plan: Some(
                json!({"kind":"plan","id":"p","title":"Plan","status":"active",
                "body":"Steps","private":"omit"}),
            ),
            model_identity: None,
        })),
        admission: None,
    };
    let rich = actions(&item, &envelope, &binding, &delivered).unwrap();
    assert_eq!(rich.len(), 1);
    assert_eq!(
        rich[0]["message"]["artifacts"].as_array().unwrap().len(),
        12
    );
    assert_eq!(
        rich[0]["message"]["changedFiles"].as_array().unwrap().len(),
        40
    );
    assert_eq!(rich[0]["message"]["changedFiles"][0]["path"], "file-0");
    assert_eq!(rich[0]["metadata"]["plan"]["body"], "Steps");
    assert!(rich[0]["metadata"]["plan"].get("private").is_none());
    assert!(rich[0]["metadata"].get("noVisibleReply").is_none());

    let (cancel_item, cancel_envelope) = claimed(
        &queue,
        "cancel",
        Some(json!({
            "kind":"cancel_turn","requestId":"request-1","turnId":"turn-1"
        })),
    );
    let cancelled = TurnOutcome {
        result: TurnOutcomeKind::Cancelled {
            turn_id: "turn-1".into(),
        },
        admission: None,
    };
    let ordered = actions(&cancel_item, &cancel_envelope, &binding, &cancelled).unwrap();
    assert_eq!(ordered.len(), 2);
    assert_eq!(ordered[0]["metadata"]["kind"], "turn_cancellation_ack");
    assert_eq!(ordered[0]["metadata"]["outcome"], "cancelled");
    assert_eq!(ordered[0]["metadata"]["requestId"], "request-1");
    assert_eq!(ordered[1]["metadata"]["kind"], "turn_cancelled");
    assert!(ordered[1]["metadata"].get("noVisibleReply").is_none());

    let already = TurnOutcome {
        result: TurnOutcomeKind::AlreadyDelivered(Box::new(AlreadyDeliveredOutcome {
            turn_id: "turn-1".into(),
            message_id: "canonical-1".into(),
            content: "Done".into(),
            work_status: None,
            accepted_work_result: None,
            runtime_failure: None,
            execution_outcome: None,
            artifacts: vec![artifact],
            changed_files: vec![],
        })),
        admission: None,
    };
    let noop = actions(&cancel_item, &cancel_envelope, &binding, &already).unwrap();
    assert_eq!(noop.len(), 1);
    assert_eq!(noop[0]["metadata"]["outcome"], "already_delivered");

    let (finalizing_item, mut finalizing_envelope) = claimed(
        &queue,
        "finalizing",
        Some(json!({"kind":"cancel_turn","requestId":"request-2",
            "turnId":"app:finalizing"})),
    );
    finalizing_envelope.routing_hints.as_mut().unwrap().turn_id = None;
    let finalizing = TurnOutcome {
        result: TurnOutcomeKind::AlreadyFinalizing {
            turn_id: "app:finalizing".into(),
        },
        admission: None,
    };
    let finalizing_actions = actions(
        &finalizing_item,
        &finalizing_envelope,
        &binding,
        &finalizing,
    )
    .unwrap();
    assert_eq!(finalizing_actions.len(), 2);
    assert_eq!(
        finalizing_actions[0]["metadata"]["outcome"],
        "already_finalizing"
    );
    assert_eq!(
        finalizing_actions[0]["metadata"]["turnId"],
        "app:finalizing"
    );
    assert_eq!(finalizing_actions[1]["metadata"]["kind"], "turn_cancelled");
    fs::remove_dir_all(root).unwrap();
}

fn claimed(
    queue: &NativeInboundQueue,
    event: &str,
    control: Option<Value>,
) -> (ClaimedInboundEvent, Envelope) {
    let mut envelope = json!({
        "eventId":format!("app:{event}"),"transport":"app","accountId":"local",
        "peer":{"kind":"dm","id":"peer"},"sender":{"id":"user"},
        "message":{"id":event,"text":"hello","timestamp":"2026-09-19T00:00:00Z"},
        "routingHints":{"sessionId":"app:peer","turnId":"turn-1", "appQueueClaimId":"claim"},
    });
    if let Some(control) = control {
        envelope["control"] = control;
    }
    let encoded = JsonDocument::from_encoded(envelope.to_string()).unwrap();
    queue.enqueue_idempotent(encoded).unwrap();
    let item = queue.claim_eligible(1, |_| true).unwrap().pop().unwrap();
    let parsed = Envelope::from_record(&item.record).unwrap();
    (item, parsed)
}

fn binding() -> StoredSessionBinding {
    StoredSessionBinding {
        session_id: "app:peer".into(),
        role: SessionRole::Butler,
        lifecycle_state: SessionLifecycleState::Active,
        project_id: None,
        app_project_id: None,
        ledger_project_id: None,
        workspace_path: "/tmp".into(),
        runtime_adapter_id: "btcc-turn-runtime".into(),
        model_provider_id: "openai".into(),
        model_ref: "openai/test".into(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: vec![SessionTransportBinding {
            transport: "app".into(),
            account_id: "local".into(),
            peer_id: "peer".into(),
            thread_id: None,
        }],
        created_at: "2026-09-19T00:00:00Z".into(),
        updated_at: "2026-09-19T00:00:00Z".into(),
        last_active_at: None,
        metadata: None,
    }
}
