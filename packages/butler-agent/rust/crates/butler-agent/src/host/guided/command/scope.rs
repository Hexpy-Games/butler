//! A command's captured reader policy, used by its blocking artifact work.
use super::*;
impl CommandScope<'_> {
    pub(super) fn read_inventory(
        &self,
    ) -> Option<Arc<butler_platform::secure_fs::SecretInventory>> {
        self.workspace_reference
            .and_then(butler_turn::workspace::WorkspaceReference::read_inventory)
    }
    pub(super) fn output_origin<'b>(
        &'b self,
        args: &'b Map<String, Value>,
        workspace: &'b Path,
        started: std::time::SystemTime,
    ) -> output::OutputOrigin<'b> {
        output::OutputOrigin {
            args,
            workspace,
            data_root: self.butler_data,
            started,
            inventory: self.read_inventory(),
        }
    }
}
impl GuidedCommand {
    pub(super) async fn artifact_snapshot(
        &self,
        scope: &CommandScope<'_>,
    ) -> Result<artifacts::Snapshot, BtccError> {
        let data = scope.butler_data.to_path_buf();
        let inventory = scope.read_inventory();
        self.jobs
            .run(move || {
                let inventory = inventory
                    .unwrap_or_else(|| butler_platform::secure_fs::SecretInventory::cached(&data));
                artifacts::snapshot(&data, &inventory)
            })
            .await
    }
}
