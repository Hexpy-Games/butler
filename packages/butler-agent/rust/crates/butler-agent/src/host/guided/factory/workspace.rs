use super::*;

impl GuidedTurnFactoryAdapter {
    /// Keep the model's policy root and tool reference on the same recovered path.
    pub(super) async fn resolved_workspace(
        &self,
        workspace: &butler_turn::workspace::WorkspaceReference,
        phase: &mut butler_turn::btcc::GuidedPhaseSelection,
    ) -> Result<(PathBuf, Vec<Arc<butler_platform::secure_fs::RootPin>>), BtccError> {
        let path = workspace.get().map_err(|e| error(e.code()))?;
        let path = tokio::task::spawn_blocking(move || std::fs::canonicalize(path))
            .await
            .map_err(|_| error("workspace_unavailable"))?
            .map_err(|_| error("workspace_unavailable"))?;
        phase.execution_policy.workspace_path = path.to_string_lossy().into_owned();
        let mut root_pins = Vec::new();
        if phase.execution_policy.access_mode != butler_turn::btcc::AccessMode::FullAccess {
            let data = self.butler_data.clone();
            let root = path.clone();
            root_pins = tokio::task::spawn_blocking(move || {
                let inventory = butler_platform::secure_fs::SecretInventory::cached(&data);
                let mut pins = vec![inventory.pin_root(&root)?];
                for relative in [
                    butler_platform::data_paths::ARTIFACTS,
                    butler_platform::data_paths::PROJECT_WRITE_CACHE,
                    butler_platform::data_paths::PROJECT_WRITE_TMP,
                ] {
                    let path = data.join(relative);
                    butler_platform::secure_fs::create_private_dir_all(&path)?;
                    pins.push(inventory.pin_root(&path)?);
                }
                Ok::<_, std::io::Error>(pins)
            })
            .await
            .map_err(|_| error("workspace_unavailable"))?
            .map_err(|_| error("workspace_unavailable"))?;
        }
        if matches!(
            butler_gateway::gateway::command_sandbox_enabled(
                self.monitoring.app_database_path.clone()
            )
            .await,
            Ok(true)
        ) {
            let inventory_root = path.clone();
            tokio::task::spawn_blocking(move || {
                if butler_platform::command_sandbox::project_write_available() {
                    butler_platform::command_sandbox::prewarm_project(&inventory_root);
                }
            });
        }
        Ok((path, root_pins))
    }
}
