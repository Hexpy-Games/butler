//! Resolve and initialize the canonical Ledger selected by a live session binding.

use crate::btcc::ResolvedProjectWorkScope;

use super::publication::ProjectWorkPublicationError;
use super::{NativeProjectLedger, ProjectLedgerReadError, active_reference};

pub(crate) struct ProjectWorkScopeLookup {
    pub app_project_id: String,
    pub workspace_path: String,
    pub ledger_project_id: Option<String>,
}

impl NativeProjectLedger {
    pub(crate) async fn resolve_work_scope(
        &self,
        input: ProjectWorkScopeLookup,
    ) -> Result<ResolvedProjectWorkScope, ProjectWorkPublicationError> {
        let scope = self
            .run(move |data_root, _| {
                let projects_root = data_root.join("project-ledger/projects");
                let ledger_root = match input.ledger_project_id.filter(|id| !id.is_empty()) {
                    Some(id) => {
                        if !active_reference::safe_id(&id) {
                            return Err(ProjectLedgerReadError::Resolution(
                                "work_scope_project_resolution_mismatch",
                            ));
                        }
                        let root = projects_root.join(id);
                        active_reference::canonical_containment(&projects_root, &root)?;
                        root
                    }
                    None => active_reference::resolve_workspace(
                        data_root,
                        &input.workspace_path,
                        &input.app_project_id,
                    )?,
                };
                let ledger_project_id = ledger_root
                    .file_name()
                    .and_then(|id| id.to_str())
                    .ok_or(ProjectLedgerReadError::Resolution(
                        "active_project_ledger_unresolved",
                    ))?
                    .to_owned();
                Ok(ResolvedProjectWorkScope {
                    app_project_id: input.app_project_id,
                    ledger_project_id,
                    ledger_root,
                })
            })
            .await
            .map_err(read_error)?;
        // Source initialization uses the Ledger id when no presentation name was captured.
        self.ensure_project_ledger(scope.clone(), scope.ledger_project_id.clone())
            .await?;
        self.run(move |data_root, _| {
            active_reference::canonical_containment(
                &data_root.join("project-ledger/projects"),
                &scope.ledger_root,
            )?;
            let ledger_root = std::fs::canonicalize(&scope.ledger_root).map_err(|_| {
                ProjectLedgerReadError::Resolution("active_project_ledger_unresolved")
            })?;
            Ok(ResolvedProjectWorkScope {
                ledger_root,
                ..scope
            })
        })
        .await
        .map_err(read_error)
    }
}

fn read_error(error: ProjectLedgerReadError) -> ProjectWorkPublicationError {
    match error {
        ProjectLedgerReadError::Resolution(code)
        | ProjectLedgerReadError::RecordShow(code)
        | ProjectLedgerReadError::DashboardInternal(code)
        | ProjectLedgerReadError::DashboardUnavailable(code) => {
            ProjectWorkPublicationError::Adapter(code)
        }
        ProjectLedgerReadError::Owner(code) => ProjectWorkPublicationError::Owner(code),
        ProjectLedgerReadError::DashboardChanged => ProjectWorkPublicationError::Uncertain,
    }
}
