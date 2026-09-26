use std::sync::Arc;

use serde_json::json;

use super::{
    InterruptedSubsessionEvent, NativeSubsessionService, SubsessionChildQueue, SubsessionEnqueue,
    WorkerProfile, WorkerProfileReader, child_metadata, child_work_scope,
};
use crate::btcc::{
    BtccError, BtccRepositories, BtccStorage, CheckpointCommand, ClaimCloseoutCorrectionInput,
    ContinueWorkCommand, DispositionCommand, DurableWorkRepository, DurableWorkService,
    DurableWorkStatus, LegacyImport, PortFuture, ReplacePlanCommand, ReviewCommand,
    SessionWorkRepository, SqliteSubsessionRepository, StartWorkCommand, StartWorkInput,
    SubsessionCreate, TestStorageFixture, TurnStore, WorkContext, WorkScope, WorkTurnScope,
    WorkView,
};
use crate::workspace::{
    OwnOptional, SessionBindingStore, SessionBindingStoreConfig, SessionLifecycleState,
    SessionRole, StoredSessionBinding, UpsertSessionBinding, WorkspaceStorageProfile,
};

use std::sync::Mutex;

fn binding(role: SessionRole, metadata: &serde_json::Value) -> StoredSessionBinding {
    StoredSessionBinding {
        session_id: "session".into(),
        role,
        lifecycle_state: SessionLifecycleState::Active,
        project_id: Some("app-project".into()),
        app_project_id: Some("app-project".into()),
        ledger_project_id: Some("ledger-project".into()),
        workspace_path: "/tmp/workspace".into(),
        runtime_adapter_id: "test-runtime".into(),
        model_provider_id: "provider".into(),
        model_ref: "provider/model".into(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: Vec::new(),
        created_at: "now".into(),
        updated_at: "now".into(),
        last_active_at: None,
        metadata: metadata.as_object().cloned(),
    }
}

#[test]
fn steward_child_inherits_normalized_runtime_policy_while_worker_stays_local() {
    let parent = binding(
        SessionRole::Butler,
        &json!({"runtimePolicy":{
            "accessMode":"ask_first",
            "tracking_mode":"ledger",
            "requiredNativeTools":null,
            "required_tools":[" query_memory ","query_memory","read_file"],
            "requiredNativeToolProfiles":["memory-read"],
            "customPolicy":"preserved"
        }}),
    );
    let packet = json!({"reasoning_effort":"medium"});
    let steward = child_metadata("steward", &packet, "read_only", &parent);
    let policy = &steward["runtimePolicy"];
    assert_eq!(policy["accessMode"], "read_only");
    assert_eq!(policy["trackingMode"], "ledger");
    assert_eq!(policy["tracking_mode"], "ledger");
    assert_eq!(
        policy["requiredNativeTools"],
        json!(["query_memory", "read_file"])
    );
    assert_eq!(
        policy["required_tools"],
        json!(["query_memory", "read_file"])
    );
    assert_eq!(policy["requiredNativeToolProfiles"], json!(["memory-read"]));
    assert_eq!(policy["authoritySource"], "parent_session");
    assert_eq!(policy["authority_source"], "parent_session");
    assert_eq!(policy["customPolicy"], "preserved");

    let worker = child_metadata("worker", &packet, "full_access", &parent);
    let policy = &worker["runtimePolicy"];
    assert_eq!(policy["trackingMode"], "local");
    assert_eq!(policy["tracking_mode"], "local");
    assert_eq!(policy["requiredNativeTools"], json!([]));
    assert_eq!(policy["required_tools"], json!([]));
    assert_eq!(policy["requiredNativeToolProfiles"], json!(["workspace"]));
    assert!(policy.get("customPolicy").is_none());
}

#[test]
fn child_root_work_scope_uses_steward_ledger_binding_but_keeps_worker_local() {
    let steward = binding(
        SessionRole::Steward,
        &json!({"runtimePolicy":{"trackingMode":"ledger"}}),
    );
    let stored = crate::btcc::StoredSubsessionDelegation {
        relation_id: "relation".into(),
        delegation_id: "delegation".into(),
        task_id: "task".into(),
        parent_session_id: "parent".into(),
        parent_turn_id: "parent-turn".into(),
        child_session_id: steward.session_id.clone(),
        child_turn_id: "child-turn".into(),
        root_work_id: "root-work".into(),
        packet: json!({"child_role":"steward"}),
        dispatch_intent: json!({}),
        anchor_message_id: "anchor".into(),
        ordinal: 1,
        safe_title: "Task".into(),
        created_at: "now".into(),
    };
    let scope = child_work_scope(&stored, &steward, "child-turn").unwrap();
    assert_eq!(scope.project_ref.as_deref(), Some("app-project"));

    let worker = binding(
        SessionRole::Worker,
        &json!({"runtimePolicy":{"trackingMode":"local"}}),
    );
    let stored = crate::btcc::StoredSubsessionDelegation {
        child_session_id: worker.session_id.clone(),
        packet: json!({"child_role":"worker"}),
        ..stored
    };
    let scope = child_work_scope(&stored, &worker, "child-turn").unwrap();
    assert_eq!(scope.project_ref, None);
}

struct EmptyQueue;

impl SubsessionChildQueue for EmptyQueue {
    fn enqueue(&self, _input: SubsessionEnqueue) -> Result<(), BtccError> {
        Ok(())
    }

    fn interrupted_event(
        &self,
        _event_id: &str,
        _session_id: &str,
        _turn_id: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError> {
        Ok(None)
    }
}

struct EmptyProfiles;

impl WorkerProfileReader for EmptyProfiles {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn read(&self, _profile_id: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async { Err(BtccError::relayed("worker_profile_missing", "missing")) })
    }
}

#[tokio::test]
async fn cancelled_child_abandons_bound_work_and_commits_cancelled_result() {
    let fixture = TestStorageFixture::activated();
    let storage_config = fixture.config("subsession-cancel");
    let test_root = storage_config.path.parent().unwrap().to_path_buf();
    let storage = BtccStorage::open(storage_config).await.unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, fresh) = turns
        .load_or_admit(&crate::btcc::test_prepared_turn())
        .await
        .unwrap();
    assert!(fresh);
    let child_turn_id = turn.turn_id;
    let child_session_id = turn.session_id;
    let durable_work = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(storage.clone(), Arc::new(|| "now".into())),
    )));
    let repository = SqliteSubsessionRepository::new(storage.clone());
    let scope = WorkTurnScope {
        turn_id: child_turn_id.clone(),
        session_id: child_session_id.clone(),
        project_ref: None,
    };
    let root_work = durable_work
        .start_work(StartWorkInput {
            scope,
            mutation_call_id: format!("subsession-root-work:delegation:task:{child_session_id}"),
            objective: "Complete the delegated task.".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    assert!(
        repository
            .create(SubsessionCreate {
                relation_id: "relation-cancel".into(),
                delegation_id: "delegation".into(),
                task_id: "task".into(),
                parent_session_id: "parent-session".into(),
                parent_turn_id: "parent-turn".into(),
                child_session_id: child_session_id.clone(),
                child_turn_id: child_turn_id.clone(),
                anchor_message_id: "anchor".into(),
                safe_title: "Delegated task".into(),
                root_work_id: root_work.work_id,
                packet: json!({
                    "objective":"Complete the delegated task.",
                    "model_ref":"provider/model",
                    "reasoning_effort":"medium",
                    "access_mode":"full_access",
                    "child_role":"steward",
                    "parent_chat_id":"parent-chat"
                }),
                dispatch_intent: json!({}),
                created_at: "now".into(),
            })
            .await
            .unwrap()
    );
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: test_root.join("sessions.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(crate::host::SystemIdentity),
    })
    .await
    .unwrap();
    // Dispatch creates the child binding before the child can run; the
    // service validates the root Work scope against it on completion.
    bindings
        .upsert(UpsertSessionBinding {
            session_id: child_session_id.clone(),
            role: SessionRole::Steward,
            project_id: None,
            app_project_id: OwnOptional::Absent,
            ledger_project_id: OwnOptional::Absent,
            workspace_path: "/tmp/workspace".into(),
            runtime_adapter_id: "test-runtime".into(),
            model_provider_id: "provider".into(),
            model_ref: "provider/model".into(),
            runtime_session_ref: None,
            provider_thread_ref: None,
            transport_bindings: Vec::new(),
            lifecycle_state: None,
            created_at: None,
            updated_at: None,
            last_active_at: None,
            metadata: Some(
                json!({"runtimePolicy":{"trackingMode":"local"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        })
        .await
        .unwrap();
    let service = NativeSubsessionService::new(
        repository.clone(),
        bindings.clone(),
        Arc::new(EmptyQueue),
        Arc::new(EmptyProfiles),
        durable_work.clone(),
        Arc::new(|| "now".into()),
    );

    service
        .complete_child(
            &child_session_id,
            &child_turn_id,
            "cancelled",
            "Delegated work was cancelled.".into(),
        )
        .await
        .unwrap();

    let work_view = durable_work
        .bound_work_for_turn(child_turn_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(work_view.status, DurableWorkStatus::Abandoned);
    let pending = repository.pending_parent_inputs().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].route, crate::btcc::ParentResultRoute::ButlerApp);
    assert!(
        pending[0].input["text"]
            .as_str()
            .unwrap()
            .contains("status: cancelled")
    );

    drop(service);
    drop(repository);
    drop(durable_work);
    bindings.close().await.unwrap();
    storage.close().await.unwrap();
}

mod child_work;
