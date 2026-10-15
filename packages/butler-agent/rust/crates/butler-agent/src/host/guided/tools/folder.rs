//! The turn's view of the session's working folder, which a folder switch
//! moves mid-turn.

use std::path::PathBuf;

use butler_turn::btcc::BtccError;

use super::GuidedTools;

impl GuidedTools {
    /// The session's working folder now; a folder switch moves it mid-turn.
    pub(super) fn current_workspace(&self) -> Result<PathBuf, BtccError> {
        match &self.binding.workspace_reference {
            Some(reference) => reference
                .get()
                .map_err(|error| BtccError::relayed(error.code(), "Workspace unavailable")),
            None => Ok(self.binding.workspace_path.clone()),
        }
    }

    /// Whether the working folder counts as the project folder now.
    pub(super) fn folder_consented(&self) -> bool {
        self.binding
            .workspace_reference
            .as_ref()
            .and_then(butler_turn::workspace::WorkspaceReference::consent)
            .unwrap_or(self.binding.project_folder.is_some())
    }

    /// The working folder now, or the turn's folder when it is unavailable;
    /// approvals and outputs bind to it.
    pub(super) fn active_workspace_path(&self) -> PathBuf {
        self.current_workspace()
            .unwrap_or_else(|_| self.binding.workspace_path.clone())
    }
}
