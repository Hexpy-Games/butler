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

fn binding(role: SessionRole, metadata: serde_json::Value) -> StoredSessionBinding {
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
        json!({"runtimePolicy":{
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
        json!({"runtimePolicy":{"trackingMode":"ledger"}}),
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
        json!({"runtimePolicy":{"trackingMode":"local"}}),
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
        Box::pin(async { Err(BtccError::new("worker_profile_missing", "missing")) })
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

struct CaptureRootWork {
    work_id: String,
    scopes: Mutex<Vec<WorkTurnScope>>,
}

fn unused<T: Send + 'static>() -> PortFuture<'static, T> {
    Box::pin(async { Err(BtccError::new("unused_test_operation", "unused")) })
}

impl DurableWorkRepository for CaptureRootWork {
    fn load_context(&self, _scope: WorkTurnScope) -> PortFuture<'_, Option<WorkContext>> {
        Box::pin(async { Ok(None) })
    }
    fn import_open_legacy_work(
        &self,
        _scope: WorkTurnScope,
    ) -> PortFuture<'_, Option<LegacyImport>> {
        Box::pin(async { Ok(None) })
    }
    fn bind_open_work(
        &self,
        _scope: WorkTurnScope,
        _expected_work_id: Option<String>,
    ) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async { Ok(None) })
    }
    fn start_work(&self, command: StartWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            let scope = command.input.scope;
            self.scopes.lock().unwrap().push(scope.clone());
            let work_scope = match scope.project_ref {
                Some(project_ref) => WorkScope::Project { project_ref },
                None => WorkScope::Session {
                    session_id: scope.session_id.clone(),
                },
            };
            Ok(WorkView {
                work_id: self.work_id.clone(),
                session_id: scope.session_id,
                scope: work_scope,
                origin: crate::btcc::WorkOrigin {
                    turn_id: scope.turn_id,
                    message_id: "message".into(),
                },
                objective: command.input.objective,
                status: crate::btcc::DurableWorkStatus::Open,
                current_stage: None,
                allowed_next_stages: Vec::new(),
                action_progress: Vec::new(),
                current_plan: None,
                latest_checkpoint: None,
                latest_plan_review: None,
                latest_result_review: None,
                latest_completion_validation: None,
                latest_disposition: None,
                effect_watermark: None,
                effect_blockers: None,
                result_refs: Vec::new(),
                created_at: "now".into(),
                updated_at: "now".into(),
            })
        })
    }
    fn continue_work(&self, _command: ContinueWorkCommand) -> PortFuture<'_, WorkView> {
        unused()
    }
    fn replace_plan(&self, _command: ReplacePlanCommand) -> PortFuture<'_, WorkView> {
        unused()
    }
    fn record_checkpoint(&self, _command: CheckpointCommand) -> PortFuture<'_, WorkView> {
        unused()
    }
    fn record_review(&self, _command: ReviewCommand) -> PortFuture<'_, WorkView> {
        unused()
    }
    fn record_disposition(&self, _command: DispositionCommand) -> PortFuture<'_, WorkView> {
        unused()
    }
    fn claim_closeout_correction(
        &self,
        _input: ClaimCloseoutCorrectionInput,
    ) -> PortFuture<'_, bool> {
        unused()
    }
    fn bound_work_for_turn(&self, _turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async { Ok(None) })
    }
    fn abandon_bound_work_for_turn(&self, _turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        unused()
    }
}

async fn child_creation_binds_work(
    child_role: SessionRole,
    parent_role: SessionRole,
    child_role_name: &str,
    child_session_id: &str,
    child_turn_id: &str,
    expected_project_ref: Option<&str>,
) {
    let fixture = TestStorageFixture::activated();
    let storage_config = fixture.config(&format!("subsession-owner-{child_role_name}"));
    let test_root = storage_config.path.parent().unwrap().to_path_buf();
    let storage = BtccStorage::open(storage_config).await.unwrap();
    let repository = SqliteSubsessionRepository::new(storage.clone());
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: test_root.join("sessions.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(crate::host::SystemIdentity),
    })
    .await
    .unwrap();
    let parent_session_id = format!("parent-{child_role_name}");
    bindings
        .upsert(UpsertSessionBinding {
            session_id: parent_session_id.clone(),
            role: parent_role,
            project_id: Some("app-project".into()),
            app_project_id: OwnOptional::Value("app-project".into()),
            ledger_project_id: OwnOptional::Value("ledger-project".into()),
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
                json!({"runtimePolicy":{"trackingMode":"ledger"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        })
        .await
        .unwrap();
    let expected_work_id = format!("root-work-{child_role_name}");
    assert!(repository
        .create(SubsessionCreate {
            relation_id: format!("relation-{child_role_name}"),
            delegation_id: format!("delegation-{child_role_name}"),
            task_id: format!("task-{child_role_name}"),
            parent_session_id,
            parent_turn_id: "parent-turn".into(),
            child_session_id: child_session_id.into(),
            child_turn_id: child_turn_id.into(),
            anchor_message_id: "anchor".into(),
            safe_title: "Delegated task".into(),
            root_work_id: expected_work_id.clone(),
            packet: json!({"child_role":child_role_name,"access_mode":"full_access","model_ref":"provider/model","reasoning_effort":"medium","objective":"Complete task."}),
            dispatch_intent: json!({}),
            created_at: "now".into(),
        })
        .await
        .unwrap());
    let stored = repository
        .by_child(child_session_id.into())
        .await
        .unwrap()
        .unwrap();
    let work_repository = Arc::new(CaptureRootWork {
        work_id: expected_work_id,
        scopes: Mutex::new(Vec::new()),
    });
    let work = Arc::new(DurableWorkService::new(work_repository.clone()));
    let service = NativeSubsessionService::new(
        repository.clone(),
        bindings.clone(),
        Arc::new(EmptyQueue),
        Arc::new(EmptyProfiles),
        work,
        Arc::new(|| "now".into()),
    );
    service.ensure_child_binding(&stored).await.unwrap();
    service
        .ensure_child_work(child_session_id, child_turn_id)
        .await
        .unwrap();

    {
        let scopes = work_repository.scopes.lock().unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].project_ref.as_deref(), expected_project_ref);
    }
    let child_binding = bindings
        .get_by_session_id(child_session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(child_binding.role, child_role);
    assert_eq!(child_binding.app_project_id.as_deref(), Some("app-project"));
    assert_eq!(
        child_binding.ledger_project_id.as_deref(),
        Some("ledger-project")
    );

    drop(service);
    drop(repository);
    drop(work_repository);
    bindings.close().await.unwrap();
    storage.close().await.unwrap();
}

#[tokio::test]
async fn child_creation_binds_steward_project_work_and_worker_session_work() {
    child_creation_binds_work(
        SessionRole::Steward,
        SessionRole::Butler,
        "steward",
        "child-steward",
        "turn-steward",
        Some("app-project"),
    )
    .await;
    child_creation_binds_work(
        SessionRole::Worker,
        SessionRole::Steward,
        "worker",
        "child-worker",
        "turn-worker",
        None,
    )
    .await;
}
