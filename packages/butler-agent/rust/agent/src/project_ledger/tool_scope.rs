//! Read-only selection for governance tools; initialization belongs to commands.

use super::{NativeProjectLedger, ProjectLedgerReadError, active_reference};
use std::path::PathBuf;

pub(crate) struct ProjectLedgerToolScopeLookup {
    pub app_project_id: Option<String>,
    pub workspace_path: Option<PathBuf>,
    pub explicit_reference: Option<String>,
}

impl NativeProjectLedger {
    pub(crate) async fn resolve_tool_scope(
        &self,
        input: ProjectLedgerToolScopeLookup,
    ) -> Result<PathBuf, ProjectLedgerReadError> {
        self.run(move |data_root, _| {
            let fallback = input.app_project_id.is_none() && input.workspace_path.is_none();
            let workspace = input
                .workspace_path
                .as_deref()
                .or_else(|| fallback.then_some(data_root));
            active_reference::resolve_reference(
                data_root,
                workspace.and_then(|path| path.to_str()),
                input.app_project_id.as_deref().unwrap_or(""),
                input.explicit_reference.as_deref(),
            )
        })
        .await
    }
}
