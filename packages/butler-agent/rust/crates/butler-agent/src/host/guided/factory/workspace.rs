use super::*;
type WorkspaceResolution = (
    PathBuf,
    Vec<Arc<butler_platform::secure_fs::RootPin>>,
    Arc<butler_platform::secure_fs::SecretInventory>,
);

impl GuidedTurnFactoryAdapter {
    /// Keep the model's policy root and tool reference on the same recovered path.
    pub(super) async fn resolved_workspace(
        &self,
        workspace: &butler_turn::workspace::WorkspaceReference,
        phase: &mut butler_turn::btcc::GuidedPhaseSelection,
    ) -> Result<WorkspaceResolution, BtccError> {
        let path = workspace.get().map_err(|e| error(e.code()))?;
        let path =
            tokio::task::spawn_blocking(move || butler_platform::secure_fs::canonicalize(path))
                .await
                .map_err(|_| error("workspace_unavailable"))?
                .map_err(|_| error("workspace_unavailable"))?;
        phase.execution_policy.workspace_path = path.to_string_lossy().into_owned();
        let data = self.butler_data.clone();
        let inventory = tokio::task::spawn_blocking(move || {
            butler_platform::secure_fs::SecretInventory::cached(&data).for_turn()
        })
        .await
        .map_err(|_| error("workspace_unavailable"))?;
        let mut root_pins = Vec::new();
        if phase.execution_policy.access_mode != butler_turn::btcc::AccessMode::FullAccess {
            let data = self.butler_data.clone();
            let root = path.clone();
            let inventory = inventory.clone();
            root_pins = tokio::task::spawn_blocking(move || {
                let mut pins = vec![inventory.pin_root(&root)?, inventory.pin_root(&data)?];
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
        Ok((path, root_pins, inventory))
    }
}

impl GuidedTurnFactoryAdapter {
    pub(super) fn file_effects(
        &self,
        workspace: &butler_turn::workspace::WorkspaceReference,
        workspace_path: &std::path::Path,
    ) -> crate::host::GuidedFileEffects {
        crate::host::GuidedFileEffects::new(
            self.capabilities.clone(),
            crate::host::RegisteredWriteContext {
                workspace_reference: Some(workspace.clone()),
                workspace_path: workspace_path.to_path_buf(),
                butler_data: self.butler_data.clone(),
                protected_ledger_roots: self.protected_ledger_roots.clone(),
                allowed_tools_and_effects: None,
                mutation_scope: None,
                installation_root: Some(self.installation_root.clone()),
                contained: false,
            },
            butler_turn::workspace::EffectFileScope {
                inventory: workspace.read_inventory(),
                workspace: workspace_path.to_path_buf(),
                butler_data: self.butler_data.clone(),
                protected_roots: self.protected_ledger_roots.clone(),
                installation_root: Some(self.installation_root.clone()),
                contained: false,
            },
        )
    }
}
