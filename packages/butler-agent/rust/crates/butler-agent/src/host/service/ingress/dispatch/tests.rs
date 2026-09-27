use std::{
    collections::HashSet,
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use serde_json::json;

use super::eligible_for_claim;
use super::interrupted::{self, ReportFailure};
use crate::host::service::ingress::{DeliveryFuture, IngressDelivery};
use butler_core::json::JsonDocument;
use butler_gateway::gateway::InboundQueue;
use butler_turn::workspace::{
    OwnOptional, SessionBindingStore, SessionBindingStoreConfig, SessionLifecycleState,
    SessionRole, SessionTransportBinding, UpsertSessionBinding, WorkspaceStorageProfile,
};

#[test]
fn waiting_source_session_admits_control_then_released_ordinary_event() {
    let root = std::env::temp_dir().join(format!(
        "butler-native-ingress-waiting-{}",
        uuid::Uuid::new_v4()
    ));
    let queue = InboundQueue::new(&root.clone());
    let ordinary = queue
        .enqueue_idempotent(JsonDocument::from_value(&event("ordinary-1", None)).unwrap())
        .unwrap();
    let control = queue
        .enqueue_idempotent(
            JsonDocument::from_value(&event(
                "control-1",
                Some(&json!({
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

fn event(event_id: &str, control: Option<&serde_json::Value>) -> serde_json::Value {
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

#[test]
fn interruption_report_failures_never_run_a_started_turn() {
    for (code, expected) in [
        ("session_binding_missing", ReportFailure::NeverStarted),
        ("inbound_envelope_invalid", ReportFailure::Unreportable),
        ("inbound_app_turn_invalid", ReportFailure::Unreportable),
        ("inbound_app_target_missing", ReportFailure::Unreportable),
        ("native_transport_unavailable", ReportFailure::Unreportable),
        ("inbound_delivery_interrupted", ReportFailure::Transient),
        ("session_binding_unavailable", ReportFailure::Transient),
        ("transcript_write_failed", ReportFailure::Transient),
    ] {
        assert_eq!(ReportFailure::of(code), expected, "{code}");
    }
}

/// A delivery that is unavailable, as when the transcript cannot be written.
struct Unavailable(AtomicUsize);

impl IngressDelivery for Unavailable {
    fn deliver(&self, _: String, _: serde_json::Value) -> DeliveryFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(false) })
    }
}

#[tokio::test]
async fn crash_interrupted_turn_whose_report_fails_is_deferred_not_run() {
    let root = std::env::temp_dir().join(format!(
        "butler-native-ingress-crash-{}",
        uuid::Uuid::new_v4()
    ));
    let queue = InboundQueue::new(&root);
    let crashed = json!({"recoveredFromProcessing":true,"recoveryReason":"processing_owner_dead"});
    let queued = queue
        .enqueue_idempotent_with_metadata(
            JsonDocument::from_value(&event("crashed-1", None)).unwrap(),
            crashed.as_object().unwrap().clone(),
        )
        .unwrap();
    let claimed = queue.claim_eligible(1, |_| true).unwrap();
    assert!(interrupted::by_crash(&claimed[0].record));
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: root.join("sessions.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(crate::host::SystemIdentity),
    })
    .await
    .unwrap();
    let delivery = Unavailable(AtomicUsize::new(0));

    // No session binding: BTCC never started the turn, so it may run.
    let never_started = interrupted::settle(
        &claimed[0],
        &queue,
        &bindings,
        &delivery,
        "crash-interrupted",
    )
    .await;
    assert!(never_started.is_none());
    assert_eq!(delivery.0.load(Ordering::SeqCst), 0);

    bindings.upsert(app_binding()).await.unwrap();
    let before = chrono::Utc::now();
    let deferred = interrupted::settle(
        &claimed[0],
        &queue,
        &bindings,
        &delivery,
        "crash-interrupted",
    )
    .await
    .expect("a started turn is never run when its report fails");
    assert_eq!(delivery.0.load(Ordering::SeqCst), 1);
    assert_eq!(deferred.handled + deferred.interrupted + deferred.failed, 0);
    let pending: serde_json::Value = serde_json::from_slice(
        &fs::read(
            root.join("runtime/inbound-events/pending")
                .join(format!("{}.json", queued.queue_id)),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(pending["metadata"]["recoveredFromProcessing"], true);
    assert_eq!(pending["metadata"]["deferrals"], 1);
    let not_before =
        chrono::DateTime::parse_from_rfc3339(pending["metadata"]["notBefore"].as_str().unwrap())
            .unwrap();
    assert!(
        not_before.timestamp_millis() >= before.timestamp_millis() + 999,
        "deferred without a backoff: {not_before}"
    );
    fs::remove_dir_all(root).unwrap();
}

fn app_binding() -> UpsertSessionBinding {
    UpsertSessionBinding {
        session_id: "source-session".into(),
        role: SessionRole::Butler,
        project_id: None,
        app_project_id: OwnOptional::Null,
        ledger_project_id: OwnOptional::Null,
        workspace_path: "/tmp/workspace".into(),
        runtime_adapter_id: "test-runtime".into(),
        model_provider_id: "provider".into(),
        model_ref: "provider/model".into(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: vec![SessionTransportBinding {
            transport: "app".into(),
            account_id: "local".into(),
            peer_id: "peer-1".into(),
            thread_id: None,
        }],
        lifecycle_state: Some(SessionLifecycleState::Active),
        created_at: None,
        updated_at: None,
        last_active_at: None,
        metadata: None,
    }
}
