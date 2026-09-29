use std::{
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use serde_json::json;

use super::{interrupted, rejected};
use crate::host::service::ingress::{DeliveryFuture, IngressDelivery};
use butler_core::json::JsonDocument;
use butler_gateway::gateway::InboundQueue;
use butler_turn::workspace::{
    OwnOptional, SessionBindingStore, SessionBindingStoreConfig, SessionLifecycleState,
    SessionRole, SessionTransportBinding, UpsertSessionBinding, WorkspaceStorageProfile,
};

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

/// A delivery that is unavailable, as when the transcript cannot be written.
struct Unavailable(AtomicUsize);

impl IngressDelivery for Unavailable {
    fn deliver(&self, _: String, _: serde_json::Value) -> DeliveryFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(false) })
    }
}

#[tokio::test]
async fn unreported_turns_are_deferred_and_rejected_turns_fail() {
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
    // A resume BTCC rejects for good is reported failed and its record failed:
    // it is never parked for a process replacement.
    let resume = json!({"kind":"resume_turn","requestId":"request-1","turnId":"turn-1"});
    let interrupted = json!({"recoveredFromRuntimeInterruption":true});
    let rejected_id = queue
        .enqueue_idempotent_with_metadata(
            JsonDocument::from_value(&event("resume-1", Some(&resume))).unwrap(),
            interrupted.as_object().unwrap().clone(),
        )
        .unwrap()
        .queue_id;
    let claimed = queue.claim_eligible(1, |_| true).unwrap();
    assert_eq!(claimed[0].record.queue_id, rejected_id);
    assert!(interrupted::replaced_once(&claimed[0].record));
    let recording = Recording(Mutex::new(Vec::new()));
    let poll = rejected::settle(
        &claimed[0],
        &queue,
        &bindings,
        &recording,
        "turn_replay_conflict",
        false,
    )
    .await;
    assert_eq!((poll.failed, poll.interrupted), (1, 0));
    let reports = recording.0.lock().unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0]["metadata"]["kind"], "turn_failed");
    assert_eq!(
        reports[0]["metadata"]["safeErrorCode"],
        "turn_replay_conflict"
    );
    assert!(
        root.join("runtime/inbound-events/failed")
            .join(format!("{rejected_id}.json"))
            .exists()
    );
    fs::remove_dir_all(root).unwrap();
}

/// A delivery that keeps what it is given.
struct Recording(Mutex<Vec<serde_json::Value>>);

impl IngressDelivery for Recording {
    fn deliver(&self, _: String, action: serde_json::Value) -> DeliveryFuture {
        self.0.lock().unwrap().push(action);
        Box::pin(async { Ok(true) })
    }
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
