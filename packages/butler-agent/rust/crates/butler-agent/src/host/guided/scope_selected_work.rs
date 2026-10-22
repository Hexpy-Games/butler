//! Select the canonical Work repository from live binding and persisted Turn scope.

use std::sync::Arc;

use butler_turn::btcc::{
    BtccError, BtccStorage, CheckpointCommand, ClaimCloseoutCorrectionInput, ContinueWorkCommand,
    DispositionCommand, DurableWorkRepository, LegacyImport, PersistedWorkTurnScope, PortFuture,
    ReplacePlanCommand, ResolvedProjectWorkScope, ReviewCommand, SessionWorkRepository,
    StartWorkCommand, WorkContext, WorkTurnScope, WorkView,
};
use butler_turn::workspace::{SessionBindingStore, SessionRole, StoredSessionBinding};

/// Host binds the actual Ledger resolver and canonical repository; neither is optional.
pub(in crate::host) trait ProjectWorkRepositoryProvider: Send + Sync {
    fn resolve_scope(
        &self,
        binding: StoredSessionBinding,
    ) -> PortFuture<'_, ResolvedProjectWorkScope>;
    fn repository(&self, scope: ResolvedProjectWorkScope) -> Arc<dyn DurableWorkRepository>;
}

pub(in crate::host) struct ScopeSelectedWorkRepository {
    bindings: SessionBindingStore,
    session: Arc<SessionWorkRepository>,
    projects: Arc<dyn ProjectWorkRepositoryProvider>,
    storage: BtccStorage,
}

impl ScopeSelectedWorkRepository {
    pub(in crate::host) fn new(
        bindings: SessionBindingStore,
        session: Arc<SessionWorkRepository>,
        projects: Arc<dyn ProjectWorkRepositoryProvider>,
        storage: BtccStorage,
    ) -> Self {
        Self {
            bindings,
            session,
            projects,
            storage,
        }
    }

    // Native composition creates this permanent marker before admitting any
    // Turn. It is an epoch fence, never a user-selectable legacy mode.
    async fn cutover_started(&self) -> Result<bool, BtccError> {
        use rusqlite::OptionalExtension;
        self.storage
            .work_model_read(|db| {
                Ok(db
                    .query_row(butler_work::cutover::EPOCH, [], |r| r.get::<_, i64>(0))
                    .optional()?
                    .is_some())
            })
            .await
            .map_err(BtccError::from)
    }

    // Legacy presentation remains readable after cutover. Only mutation
    // selection is fenced; import_open_legacy_work also writes legacy rows.
    async fn writable_for_scope(
        &self,
        scope: &WorkTurnScope,
    ) -> Result<Arc<dyn DurableWorkRepository>, BtccError> {
        self.require_writable().await?;
        self.store_for_scope(scope).await
    }

    async fn writable_for_turn(
        &self,
        turn_id: &str,
    ) -> Result<Arc<dyn DurableWorkRepository>, BtccError> {
        self.require_writable().await?;
        self.store_for_turn(turn_id).await
    }

    async fn require_writable(&self) -> Result<(), BtccError> {
        if self.cutover_started().await? {
            return Err(scope_error("work_model_legacy_writers_retired"));
        }
        Ok(())
    }

    async fn require_binding(&self, session_id: &str) -> Result<StoredSessionBinding, BtccError> {
        self.bindings
            .get_by_session_id(session_id)
            .await
            .map_err(BtccError::from)?
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
            if self.cutover_started().await? {
                return Ok(None);
            }
            self.writable_for_scope(&scope)
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
            self.writable_for_scope(&scope)
                .await?
                .bind_open_work(scope, expected)
                .await
        })
    }
    fn start_work(&self, command: StartWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.writable_for_scope(&command.input.scope)
                .await?
                .start_work(command)
                .await
        })
    }
    fn continue_work(&self, command: ContinueWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.writable_for_scope(&command.input.scope)
                .await?
                .continue_work(command)
                .await
        })
    }
    fn replace_plan(&self, command: ReplacePlanCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.writable_for_scope(&command.input.scope)
                .await?
                .replace_plan(command)
                .await
        })
    }
    fn record_checkpoint(&self, command: CheckpointCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.writable_for_scope(&command.input.scope)
                .await?
                .record_checkpoint(command)
                .await
        })
    }
    fn record_review(&self, command: ReviewCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.writable_for_scope(&command.input.scope)
                .await?
                .record_review(command)
                .await
        })
    }
    fn record_disposition(&self, command: DispositionCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.writable_for_scope(&command.input.scope)
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
            self.writable_for_scope(&input.scope)
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
            self.writable_for_turn(&turn_id)
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
    BtccError::relayed(code, code)
}
