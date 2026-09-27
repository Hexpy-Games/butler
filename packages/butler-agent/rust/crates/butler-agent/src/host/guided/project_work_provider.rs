//! Bind Work routing to the actual shared Ledger resolver and canonical repository.

use std::sync::Arc;

use butler_ledger::project_ledger::{ProjectLedger, ProjectWork, ProjectWorkScopeLookup};
use butler_turn::btcc::{BtccError, DurableWorkRepository, PortFuture, ResolvedProjectWorkScope};
use butler_turn::workspace::StoredSessionBinding;

use crate::host::guided::scope_selected_work::ProjectWorkRepositoryProvider;

pub(in crate::host) struct ProjectWorkProvider {
    ledger: ProjectLedger,
    work: Arc<ProjectWork>,
}

impl ProjectWorkProvider {
    pub(in crate::host) fn new(ledger: ProjectLedger, work: Arc<ProjectWork>) -> Self {
        Self { ledger, work }
    }
}

impl ProjectWorkRepositoryProvider for ProjectWorkProvider {
    fn resolve_scope(
        &self,
        binding: StoredSessionBinding,
    ) -> PortFuture<'_, ResolvedProjectWorkScope> {
        Box::pin(async move {
            let app_project_id = binding
                .app_project_id
                .or(binding.project_id)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    BtccError::relayed(
                        "work_scope_project_binding_missing",
                        "work_scope_project_binding_missing",
                    )
                })?;
            self.ledger
                .resolve_work_scope(ProjectWorkScopeLookup {
                    app_project_id,
                    workspace_path: binding.workspace_path,
                    ledger_project_id: binding.ledger_project_id,
                })
                .await
                .map_err(|error| BtccError::relayed(error.code().to_owned(), error.code()))
        })
    }

    fn repository(&self, scope: ResolvedProjectWorkScope) -> Arc<dyn DurableWorkRepository> {
        self.work.repository(scope)
    }
}

/// Prepares one current canonical snapshot for one operation-result read.
pub(in crate::host) struct ProjectResultAuthority {
    ledger: ProjectLedger,
    data_root: std::path::PathBuf,
}

impl ProjectResultAuthority {
    pub(in crate::host) fn new(ledger: ProjectLedger, data_root: std::path::PathBuf) -> Self {
        Self { ledger, data_root }
    }
}

impl butler_turn::btcc::ProjectWorkResultAuthorityFactory for ProjectResultAuthority {
    fn prepare(
        &self,
        location: butler_turn::btcc::ProjectWorkResultAuthorityLocation,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        Arc<dyn butler_turn::btcc::ExactProjectWorkResultAuthority>,
                        butler_turn::btcc::StorageError,
                    >,
                > + Send
                + '_,
        >,
    > {
        Box::pin(async move {
            let scope = ResolvedProjectWorkScope {
                ledger_root: self
                    .data_root
                    .join("project-ledger/projects")
                    .join(&location.ledger_project_id),
                ledger_project_id: location.ledger_project_id,
                app_project_id: location.app_project_id,
            };
            butler_ledger::project_ledger::prepare_exact_project_work_result_authority(
                &self.ledger,
                scope,
                vec![location.work_id],
            )
            .await
        })
    }
}
