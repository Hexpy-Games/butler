//! Moving a handoff binding preserves earlier Work and its delegated owner.
use super::super::publication::{ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate};
use super::{ProjectWorkRepository, codec::Snapshot, invalid};
use butler_turn::btcc::{BtccError, ProjectWorkOperationIdentity};
use serde_json::Value;

impl ProjectWorkRepository {
    pub(super) async fn retire_handoff_head(
        &self,
        prior: &Snapshot,
        turn: &str,
        identity: &ProjectWorkOperationIdentity,
        at: &str,
    ) -> Result<ProjectLedgerRecordUpdate, BtccError> {
        let mut bindings = prior
            .manifest
            .get("bindingRefs")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
        for binding in &mut bindings {
            if binding.get("turnId").and_then(Value::as_str) == Some(turn) {
                crate::project_ledger::work_json::set_field(
                    binding,
                    "isCurrent",
                    Value::Bool(false),
                );
            }
        }
        let mut view = prior.view.clone();
        view.updated_at = at.into();
        self.manifest_update(super::write::ManifestPublicationInput {
            prior: Some(prior),
            view: &view,
            identity,
            binding_refs: Value::Array(bindings),
            session_head: false,
            revisions: &super::codec::revisions(&prior.manifest),
            operation: ProjectLedgerRecordOperation::Update,
        })
        .await
    }
}

pub(super) fn next_binding_revision(prior: Option<&Snapshot>, turn: &str) -> u64 {
    prior
        .and_then(|prior| prior.manifest.get("bindingRefs").and_then(Value::as_array))
        .into_iter()
        .flatten()
        .filter(|item| item.get("turnId").and_then(Value::as_str) == Some(turn))
        .filter_map(|item| item.get("revision").and_then(Value::as_u64))
        .max()
        .unwrap_or(0)
        + 1
}
