//! Root Work binding when a child subsession is created.

use super::*;

struct CaptureRootWork {
    work_id: String,
    scopes: Mutex<Vec<WorkTurnScope>>,
}

fn unused<T: Send + 'static>() -> PortFuture<'static, T> {
    Box::pin(async { Err(BtccError::relayed("unused_test_operation", "unused")) })
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
