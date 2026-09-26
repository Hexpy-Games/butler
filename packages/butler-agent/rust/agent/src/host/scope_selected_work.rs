//! Select the canonical Work repository from live binding and persisted Turn scope.

use std::sync::Arc;

use crate::btcc::{
    BtccError, CheckpointCommand, ClaimCloseoutCorrectionInput, ContinueWorkCommand,
    DispositionCommand, DurableWorkRepository, LegacyImport, PersistedWorkTurnScope, PortFuture,
    ReplacePlanCommand, ResolvedProjectWorkScope, ReviewCommand, SessionWorkRepository,
    StartWorkCommand, WorkContext, WorkTurnScope, WorkView,
};
use crate::workspace::{SessionBindingStore, SessionRole, StoredSessionBinding};

/// Host binds the actual Ledger resolver and canonical repository; neither is optional.
pub(super) trait ProjectWorkRepositoryProvider: Send + Sync {
    fn resolve_scope(
        &self,
        binding: StoredSessionBinding,
    ) -> PortFuture<'_, ResolvedProjectWorkScope>;
    fn repository(&self, scope: ResolvedProjectWorkScope) -> Arc<dyn DurableWorkRepository>;
}

pub(super) struct ScopeSelectedWorkRepository {
    bindings: SessionBindingStore,
    session: Arc<SessionWorkRepository>,
    projects: Arc<dyn ProjectWorkRepositoryProvider>,
}

impl ScopeSelectedWorkRepository {
    pub(super) fn new(
        bindings: SessionBindingStore,
        session: Arc<SessionWorkRepository>,
        projects: Arc<dyn ProjectWorkRepositoryProvider>,
    ) -> Self {
        Self {
            bindings,
            session,
            projects,
        }
    }

    async fn require_binding(&self, session_id: &str) -> Result<StoredSessionBinding, BtccError> {
        self.bindings
            .get_by_session_id(session_id)
            .await
            .map_err(|error| BtccError::new(error.code, error.message))?
            .ok_or_else(|| scope_error("work_scope_session_binding_missing"))
    }

    async fn store_for_scope(
        &self,
        scope: &WorkTurnScope,
    ) -> Result<Arc<dyn DurableWorkRepository>, BtccError> {
        let binding = self.require_binding(&scope.session_id).await?;
        let app_id = app_project_id(&binding);
        if session_owned(&binding) {
            if scope
                .project_ref
                .as_deref()
                .is_some_and(|id| !id.is_empty())
            {
                return Err(scope_error("work_scope_session_binding_mismatch"));
            }
            return Ok(self.session.clone());
        }
        if app_id.is_none_or(str::is_empty) {
            return Err(scope_error("work_scope_project_binding_missing"));
        }
        if scope.project_ref.as_deref() != app_id {
            return Err(scope_error("work_scope_project_binding_mismatch"));
        }
        self.project_store(binding).await
    }

    async fn store_for_turn(
        &self,
        turn_id: &str,
    ) -> Result<Arc<dyn DurableWorkRepository>, BtccError> {
        let persisted = self
            .session
            .persisted_scope_for_turn(turn_id.to_owned())
            .await?
            .ok_or_else(|| scope_error("work_scope_turn_missing"))?;
        match persisted {
            PersistedWorkTurnScope::Session => Ok(self.session.clone()),
            PersistedWorkTurnScope::Unbound { session_id } => {
                let binding = self.require_binding(&session_id).await?;
                if session_owned(&binding) {
                    Ok(self.session.clone())
                } else {
                    self.project_store(binding).await
                }
            }
            PersistedWorkTurnScope::Project {
                session_id,
                app_project_id: app_id,
                ledger_project_id,
            } => {
                let binding = self.require_binding(&session_id).await?;
                if app_project_id(&binding) != Some(app_id.as_str())
                    || binding
                        .ledger_project_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .is_some_and(|id| id != ledger_project_id)
                {
                    return Err(scope_error("work_scope_project_projection_mismatch"));
                }
                let resolved = self.projects.resolve_scope(binding).await?;
                if resolved.app_project_id != app_id
                    || resolved.ledger_project_id != ledger_project_id
                {
                    return Err(scope_error("work_scope_project_projection_mismatch"));
                }
                Ok(self.projects.repository(resolved))
            }
        }
    }

    async fn project_store(
        &self,
        binding: StoredSessionBinding,
    ) -> Result<Arc<dyn DurableWorkRepository>, BtccError> {
        let app_id = app_project_id(&binding).map(str::to_owned);
        let ledger_id = binding.ledger_project_id.clone();
        if app_id.as_deref().is_none_or(str::is_empty) {
            return Err(scope_error("work_scope_project_binding_missing"));
        }
        let resolved = self.projects.resolve_scope(binding).await?;
        if app_id.as_deref() != Some(resolved.app_project_id.as_str())
            || ledger_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .is_some_and(|id| id != resolved.ledger_project_id)
        {
            return Err(scope_error("work_scope_project_resolution_mismatch"));
        }
        // Scoped handles share owners. There is no unbounded per-project store cache.
        Ok(self.projects.repository(resolved))
    }
}

impl DurableWorkRepository for ScopeSelectedWorkRepository {
    fn load_context(&self, scope: WorkTurnScope) -> PortFuture<'_, Option<WorkContext>> {
        Box::pin(async move {
            self.store_for_scope(&scope)
                .await?
                .load_context(scope)
                .await
        })
    }
    fn import_open_legacy_work(
        &self,
        scope: WorkTurnScope,
    ) -> PortFuture<'_, Option<LegacyImport>> {
        Box::pin(async move {
            self.store_for_scope(&scope)
                .await?
                .import_open_legacy_work(scope)
                .await
        })
    }
    fn bind_open_work(
        &self,
        scope: WorkTurnScope,
        expected: Option<String>,
    ) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move {
            self.store_for_scope(&scope)
                .await?
                .bind_open_work(scope, expected)
                .await
        })
    }
    fn start_work(&self, command: StartWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.store_for_scope(&command.input.scope)
                .await?
                .start_work(command)
                .await
        })
    }
    fn continue_work(&self, command: ContinueWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.store_for_scope(&command.input.scope)
                .await?
                .continue_work(command)
                .await
        })
    }
    fn replace_plan(&self, command: ReplacePlanCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.store_for_scope(&command.input.scope)
                .await?
                .replace_plan(command)
                .await
        })
    }
    fn record_checkpoint(&self, command: CheckpointCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.store_for_scope(&command.input.scope)
                .await?
                .record_checkpoint(command)
                .await
        })
    }
    fn record_review(&self, command: ReviewCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.store_for_scope(&command.input.scope)
                .await?
                .record_review(command)
                .await
        })
    }
    fn record_disposition(&self, command: DispositionCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.store_for_scope(&command.input.scope)
                .await?
                .record_disposition(command)
                .await
        })
    }
    fn claim_closeout_correction(
        &self,
        input: ClaimCloseoutCorrectionInput,
    ) -> PortFuture<'_, bool> {
        Box::pin(async move {
            self.store_for_scope(&input.scope)
                .await?
                .claim_closeout_correction(input)
                .await
        })
    }
    fn bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move {
            self.store_for_turn(&turn_id)
                .await?
                .bound_work_for_turn(turn_id)
                .await
        })
    }
    fn abandon_bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move {
            self.store_for_turn(&turn_id)
                .await?
                .abandon_bound_work_for_turn(turn_id)
                .await
        })
    }
}

fn app_project_id(binding: &StoredSessionBinding) -> Option<&str> {
    binding
        .app_project_id
        .as_deref()
        .or(binding.project_id.as_deref())
}

fn session_owned(binding: &StoredSessionBinding) -> bool {
    let policy = binding
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("runtimePolicy"))
        .and_then(serde_json::Value::as_object);
    let mode = policy.and_then(|policy| {
        policy
            .get("trackingMode")
            .filter(|value| !value.is_null())
            .or_else(|| policy.get("tracking_mode"))
            .and_then(serde_json::Value::as_str)
    });
    let child_role = matches!(&binding.role, &SessionRole::Worker | &SessionRole::Steward);
    let app_id_missing = app_project_id(binding).is_none_or(str::is_empty);
    let ledger_id_missing = binding
        .ledger_project_id
        .as_deref()
        .is_none_or(str::is_empty);
    match (child_role, mode) {
        (true, Some("local")) => true,
        (true, Some("ledger")) => false,
        (true, _) => app_id_missing && ledger_id_missing,
        (false, _) => app_id_missing,
    }
}

fn scope_error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}

#[cfg(test)]
mod tests {
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

        let missing_app = match routed
            .store_for_scope(&WorkTurnScope {
                turn_id: "ledger-without-app-turn".into(),
                session_id: "ledger-without-app".into(),
                project_ref: None,
            })
            .await
        {
            Ok(_) => panic!("ledger binding without an app project must not use session Work"),
            Err(error) => error,
        };
        assert_eq!(missing_app.code, "work_scope_project_binding_missing");
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
}
