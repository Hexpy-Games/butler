//! Read-only selection for governance tools; initialization belongs to commands.

use super::{ProjectLedger, ProjectLedgerReadError, active_reference};
use std::path::PathBuf;

/// What a governance tool knows about the project it runs for.
pub struct ProjectLedgerToolScopeLookup {
    /// The App project id.
    pub app_project_id: Option<String>,
    /// The workspace the tool runs in.
    pub workspace_path: Option<PathBuf>,
    /// An explicit Ledger id or path the tool was given.
    pub explicit_reference: Option<String>,
}

impl ProjectLedger {
    /// The Ledger root the tool reads, without initializing one.
    pub async fn resolve_tool_scope(
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
