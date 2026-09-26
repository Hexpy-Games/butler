use super::{ProjectWorkRepositoryProvider, ScopeSelectedWorkRepository, session_owned};
use crate::btcc::{
    BtccStorage, DurableWorkRepository, PortFuture, ResolvedProjectWorkScope,
    SessionWorkRepository, TestStorageFixture, WorkTurnScope,
};
use crate::workspace::{
    OwnOptional, SessionBindingStore, SessionBindingStoreConfig, SessionLifecycleState,
    SessionRole, StoredSessionBinding, UpsertSessionBinding, WorkspaceStorageProfile,
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct CountingProjectResolver {
    session_repository: Arc<SessionWorkRepository>,
    calls: AtomicUsize,
}

impl ProjectWorkRepositoryProvider for CountingProjectResolver {
    fn resolve_scope(
        &self,
        binding: StoredSessionBinding,
    ) -> PortFuture<'_, ResolvedProjectWorkScope> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let app_project_id = binding.app_project_id.or(binding.project_id);
        let ledger_project_id = binding.ledger_project_id;
        Box::pin(async move {
            Ok(ResolvedProjectWorkScope {
                app_project_id: app_project_id.unwrap_or_default(),
                ledger_project_id: ledger_project_id.unwrap_or_default(),
                ledger_root: "/tmp/ledger".into(),
            })
        })
    }

    fn repository(&self, _scope: ResolvedProjectWorkScope) -> Arc<dyn DurableWorkRepository> {
        self.session_repository.clone()
    }
}

fn binding(role: SessionRole, tracking_mode: &str) -> StoredSessionBinding {
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
        metadata: json!({"runtimePolicy":{"trackingMode":tracking_mode}})
            .as_object()
            .cloned(),
    }
}

#[test]
fn only_explicit_local_subsession_roles_select_session_owner_for_project_bindings() {
    assert!(session_owned(&binding(SessionRole::Worker, "local")));
    assert!(session_owned(&binding(SessionRole::Steward, "local")));
    assert!(!session_owned(&binding(SessionRole::Steward, "ledger")));
    assert!(!session_owned(&binding(SessionRole::Butler, "local")));
}

#[tokio::test]
async fn store_for_scope_routes_local_worker_to_session_and_ledger_steward_to_project() {
    let fixture = TestStorageFixture::activated();
    let storage_config = fixture.config("scope-selected-child-owner");
    let test_root = storage_config.path.parent().unwrap().to_path_buf();
    let storage = BtccStorage::open(storage_config).await.unwrap();
    let session_repository = Arc::new(SessionWorkRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: test_root.join("sessions.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(crate::host::SystemIdentity),
    })
    .await
    .unwrap();
    for (session_id, role, mode, with_app_project) in [
        ("child-worker", SessionRole::Worker, "local", true),
        ("child-steward", SessionRole::Steward, "ledger", true),
        ("ledger-without-app", SessionRole::Steward, "ledger", false),
        (
            "ordinary-ledger-without-app",
            SessionRole::Butler,
            "ledger",
            false,
        ),
    ] {
        bindings
            .upsert(UpsertSessionBinding {
                session_id: session_id.into(),
                role,
                project_id: with_app_project.then(|| "app-project".into()),
                app_project_id: if with_app_project {
                    OwnOptional::Value("app-project".into())
                } else {
                    OwnOptional::Null
                },
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
                    json!({"runtimePolicy":{"trackingMode":mode}})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            })
            .await
            .unwrap();
    }
    let resolver = Arc::new(CountingProjectResolver {
        session_repository: session_repository.clone(),
        calls: AtomicUsize::new(0),
    });
    let routed = ScopeSelectedWorkRepository::new(
        bindings.clone(),
        session_repository.clone(),
        resolver.clone(),
    );

    routed
        .store_for_scope(&WorkTurnScope {
            turn_id: "worker-turn".into(),
            session_id: "child-worker".into(),
            project_ref: None,
        })
        .await
        .unwrap();
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);

    routed
        .store_for_scope(&WorkTurnScope {
            turn_id: "steward-turn".into(),
            session_id: "child-steward".into(),
            project_ref: Some("app-project".into()),
        })
        .await
        .unwrap();
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);

    let Err(missing_app) = routed
        .store_for_scope(&WorkTurnScope {
            turn_id: "ledger-without-app-turn".into(),
            session_id: "ledger-without-app".into(),
            project_ref: None,
        })
        .await
    else {
        panic!("ledger binding without an app project must not use session Work")
    };
    assert_eq!(missing_app.code(), "work_scope_project_binding_missing");
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);

    routed
        .store_for_scope(&WorkTurnScope {
            turn_id: "ordinary-turn".into(),
            session_id: "ordinary-ledger-without-app".into(),
            project_ref: None,
        })
        .await
        .unwrap();
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);

    drop(routed);
    drop(resolver);
    drop(session_repository);
    bindings.close().await.unwrap();
    storage.close().await.unwrap();
}
