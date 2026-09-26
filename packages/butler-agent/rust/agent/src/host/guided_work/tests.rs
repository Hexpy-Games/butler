use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, params};
use serde_json::json;

use crate::btcc::{
    BtccRepositories, BtccStorage, BtccStorageConfig, DurableWorkService, DurableWorkStatus, Peer,
    PeerKind, PreparedTurn, ProcessLiveness, RuntimeOwnerIdentity, Sender, SessionRole,
    SessionWorkRepository, StorageActivation, StorageProfile, TurnMessage, TurnRequest, TurnRoute,
    TurnStore, TurnTrigger, WorkTurnScope,
};

use super::{NativeGuidedWork, decision};

struct Live;
impl ProcessLiveness for Live {
    fn is_alive(&self, _: &RuntimeOwnerIdentity) -> bool {
        true
    }
}

#[tokio::test]
async fn real_sqlite_work_final_reconcile_persists_current_open_disposition() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("guided-work-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("agent-btcc.sqlite");
    let manifest = "guided-work-test-manifest";
    let seed = Connection::open(&path).unwrap();
    seed.execute_batch(
        "CREATE TABLE agent_storage_migration_receipt (
        singleton INTEGER PRIMARY KEY, manifest_id TEXT NOT NULL, receipt_json TEXT NOT NULL);
        CREATE TABLE agent_storage_activation_marker (
        singleton INTEGER PRIMARY KEY, manifest_id TEXT NOT NULL, marker_json TEXT NOT NULL);",
    )
    .unwrap();
    seed.execute(
        "INSERT INTO agent_storage_migration_receipt VALUES (1, ?1, ?2)",
        params![
            manifest,
            json!({"schema":"butler.agent-btcc-storage-migration.v1",
            "manifestId":manifest})
            .to_string()
        ],
    )
    .unwrap();
    seed.execute(
        "INSERT INTO agent_storage_activation_marker VALUES (1, ?1, ?2)",
        params![
            manifest,
            json!({"schema":"butler.agent-btcc-storage-activation.v1",
            "manifestId":manifest,"storageContract":"split-v1",
            "firstActivatedAt":"now","activatedAt":"now"})
            .to_string()
        ],
    )
    .unwrap();
    drop(seed);
    let storage = BtccStorage::open(BtccStorageConfig {
        path,
        profile: StorageProfile::Durable,
        activation: StorageActivation {
            manifest_id: manifest.into(),
        },
        runtime_owner: RuntimeOwnerIdentity {
            owner_id: "guided-work-test".into(),
            host_id: "test".into(),
            process_id: std::process::id(),
            process_started_at_ms: 1,
        },
        process_liveness: Arc::new(Live),
    })
    .await
    .unwrap();
    let repos = BtccRepositories::new(storage.clone(), None);
    let request = TurnRequest {
        turn_id: "turn".into(),
        recovery_attempt: None,
        session_id: "session".into(),
        event_id: "event".into(),
        transport: "app".into(),
        account_id: "account".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "peer".into(),
            parent_id: None,
        },
        sender: Sender {
            id: "user".into(),
            display_name: None,
        },
        message: TurnMessage {
            id: "message".into(),
            content: "finish work".into(),
            timestamp: "now".into(),
            attachments: vec![],
            image_admission: None,
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role: SessionRole::Butler,
            workspace_path: "/tmp".into(),
            project_id: None,
            reason: None,
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: None,
        app_turn_context: None,
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: None,
        preparation_cancellation: Default::default(),
    };
    repos
        .load_or_admit(&PreparedTurn {
            preparation_id: "preparation".into(),
            request,
            command: json!({"kind":"run","turnId":"turn","sessionId":"session",
            "triggerKey":"event","message":{"messageId":"message","content":"finish work"},
            "modelSelection":{"provider":"openai","model":"gpt"},
            "context":{"messageContent":"finish work"}}),
            admission_input_hash: "hash".into(),
            is_fresh: true,
        })
        .await
        .unwrap();
    let scope = WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    };
    let service = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(
            storage.clone(),
            Arc::new(|| "2026-09-19T00:00:00.000Z".into()),
        ),
    )));
    let started = service
        .start_work(
            serde_json::from_value(json!({
        "turnId":"turn","sessionId":"session","mutationCallId":"start",
        "objective":"finish work"}))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(started.status, DurableWorkStatus::Open);
    let port = NativeGuidedWork::new(
        service,
        scope,
        "local".into(),
        "butler",
        "English".into(),
        "finish work".into(),
    )
    .unwrap();
    let candidate = port.candidate("answer").await.unwrap();
    assert!(matches!(
        candidate,
        crate::btcc::CandidateDisposition::Continue(_)
    ));
    let published = port.reconcile_text("answer").await.unwrap();
    assert!(published.starts_with("Work completion could not be confirmed"));
    let bound = port.bound().await.unwrap().unwrap();
    assert_eq!(bound.status, DurableWorkStatus::Open);
    assert!(
        bound
            .latest_disposition
            .as_ref()
            .unwrap()
            .runtime_owned_open
    );
    assert!(decision::fresh(Some(&bound), "turn").unwrap());
    assert_eq!(port.reconcile_text("answer").await.unwrap(), published);
    repos.close().await.unwrap();
    drop(storage);
    std::fs::remove_dir_all(directory).unwrap();
}
