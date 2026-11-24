use super::GuidedTools;
use butler_turn::btcc::{BtccError, PermissionRules};
use butler_turn::workspace::{FolderRefusal, FolderRoots, allowed_folder};
use std::path::PathBuf;

impl GuidedTools {
    pub(super) async fn permission_rules(&self) -> Result<PermissionRules, BtccError> {
        let owner = (!self.unattended()).then(|| self.binding.owner_session_id.clone());
        self.authority
            .permission_rules(owner)
            .await
            .map_err(Into::into)
    }

    pub(super) async fn allowed_folder(
        &self,
        path: String,
    ) -> Result<Result<PathBuf, FolderRefusal>, BtccError> {
        let data = self.binding.butler_data.clone();
        let protected = self.binding.protected_ledger_roots.clone();
        let installation = self.binding.installation_root.clone();
        tokio::task::spawn_blocking(move || {
            allowed_folder(
                &path,
                &FolderRoots {
                    butler_data: &data,
                    protected_roots: &protected,
                    installation_root: installation.as_deref(),
                },
            )
        })
        .await
        .map_err(|error| {
            BtccError::relay(
                "scope_classification_failed",
                "Folder resolution failed",
                error,
            )
        })
    }
}
