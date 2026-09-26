//! Bind Work routing to the actual shared Ledger resolver and canonical repository.

use std::sync::Arc;

use crate::{
    btcc::{BtccError, DurableWorkRepository, PortFuture, ResolvedProjectWorkScope},
    project_ledger::{NativeProjectLedger, NativeProjectWork, ProjectWorkScopeLookup},
    workspace::StoredSessionBinding,
};

use super::scope_selected_work::ProjectWorkRepositoryProvider;

pub(super) struct NativeProjectWorkProvider {
    ledger: NativeProjectLedger,
    work: Arc<NativeProjectWork>,
}

impl NativeProjectWorkProvider {
    pub(super) fn new(ledger: NativeProjectLedger, work: Arc<NativeProjectWork>) -> Self {
        Self { ledger, work }
    }
}

impl ProjectWorkRepositoryProvider for NativeProjectWorkProvider {
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
                    BtccError::new(
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
                .map_err(|error| BtccError::new(error.code(), error.code()))
        })
    }

    fn repository(&self, scope: ResolvedProjectWorkScope) -> Arc<dyn DurableWorkRepository> {
        self.work.repository(scope)
    }
}

/// Prepares one current canonical snapshot for one operation-result read.
pub(super) struct NativeProjectResultAuthority {
    ledger: NativeProjectLedger,
    data_root: std::path::PathBuf,
}

impl NativeProjectResultAuthority {
    pub(super) fn new(ledger: NativeProjectLedger, data_root: std::path::PathBuf) -> Self {
        Self { ledger, data_root }
    }
}

impl crate::btcc::ProjectWorkResultAuthorityFactory for NativeProjectResultAuthority {
    fn prepare(
        &self,
        location: crate::btcc::ProjectWorkResultAuthorityLocation,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        Arc<dyn crate::btcc::ExactProjectWorkResultAuthority>,
                        crate::btcc::StorageError,
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
            crate::project_ledger::prepare_exact_project_work_result_authority(
                &self.ledger,
                scope,
                vec![location.work_id],
            )
            .await
        })
    }
}
