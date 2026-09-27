use serde_json::{Value, json};

use crate::btcc::{
    BtccError, ContinueWorkCommand, ProjectWorkOperationIdentity, ProjectWorkOperationKind,
    WorkTurnScope, WorkView,
};

use super::super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordUpdate};
use super::codec::{self, Snapshot};
use super::relation::is_open;
use super::start::binding_child;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn bind_open_impl(
        &self,
        scope: WorkTurnScope,
        expected: Option<String>,
    ) -> Result<Option<WorkView>, BtccError> {
        self.assert_scope(&scope)?;
        let relation = self.relation(&scope).await?;
        if let Some(binding) = relation.binding {
            let current = self
                .require_bound_relation(&scope, relation.head.as_ref(), &binding)
                .await?;
            if expected
                .as_ref()
                .is_some_and(|id| id != &current.view.work_id)
            {
                return Err(invalid("project_work_binding_identity_mismatch"));
            }
            let caller =
                self.binding_identity(&scope, expected.as_deref(), &current.view.work_id)?;
            let binding_ref = binding_ref(&current, &scope.turn_id)?;
            let child = current
                .children
                .get(&binding_ref)
                .ok_or_else(|| invalid("project_work_turn_binding_missing"))?;
            let recorded = codec::identity_from_value(
                child
                    .get("operationIdentity")
                    .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
            )?;
            self.require_receipt(
                recorded.clone(),
                binding_ref,
                ProjectLedgerRecordKind::Reference,
                Some(current.view.work_id.clone()),
            )
            .await?;
            if recorded.kind != ProjectWorkOperationKind::MutationCall
                && (recorded.kind != caller.kind || recorded.id != caller.id)
            {
                return Err(invalid("project_work_binding_identity_mismatch"));
            }
            return Ok(is_open(&current.view).then_some(current.view));
        }
        let Some(current) = relation.head else {
            return Ok(None);
        };
        if expected
            .as_ref()
            .is_some_and(|id| id != &current.view.work_id)
            || !is_open(&current.view)
            || current.view.session_id != scope.session_id
        {
            return Ok(None);
        }
        let identity = self.binding_identity(&scope, expected.as_deref(), &current.view.work_id)?;
        let repo = self.clone();
        let id = current.view.work_id.clone();
        let prepare_identity = identity.clone();
        self.publish(
            identity,
            move || async move {
                Ok(Some(
                    repo.binding_updates(&current, &scope, &prepare_identity)
                        .await?,
                ))
            },
            true,
        )
        .await?;
        Ok(Some(self.require_current(&id).await?.view))
    }

    pub(super) async fn continue_impl(
        &self,
        command: ContinueWorkCommand,
    ) -> Result<WorkView, BtccError> {
        self.assert_scope(&command.input.scope)?;
        let identity =
            codec::mutation_identity(&command.input.mutation_call_id, &command.request_sha256);
        let repo = self.clone();
        let requested_id = command.input.work_id.clone();
        let result_id = requested_id.clone();
        let prepare_identity = identity.clone();
        self.publish(
            identity,
            move || async move {
                let relation = repo.relation(&command.input.scope).await?;
                if let Some(binding) = relation.binding {
                    if binding.view.work_id != requested_id {
                        return Err(invalid("project_work_turn_already_bound"));
                    }
                    repo.require_bound_relation(
                        &command.input.scope,
                        relation.head.as_ref(),
                        &binding,
                    )
                    .await?;
                    let fresh = repo.require_current(&requested_id).await?;
                    return Ok(Some(vec![
                        repo.heartbeat_update(&fresh, &prepare_identity).await?,
                    ]));
                }
                if relation
                    .head
                    .as_ref()
                    .is_none_or(|head| head.view.work_id != requested_id)
                {
                    return Err(invalid("project_work_continuation_target_invalid"));
                }
                let current = repo.require_current(&requested_id).await?;
                if !is_open(&current.view)
                    || current.view.session_id != command.input.scope.session_id
                {
                    return Err(invalid("project_work_continuation_target_invalid"));
                }
                Ok(Some(
                    repo.binding_updates(&current, &command.input.scope, &prepare_identity)
                        .await?,
                ))
            },
            true,
        )
        .await?;
        Ok(self.require_current(&result_id).await?.view)
    }

    async fn binding_updates(
        &self,
        current: &Snapshot,
        scope: &WorkTurnScope,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        if binding_ref(current, &scope.turn_id).is_ok() {
            return Ok(vec![self.heartbeat_update(current, identity).await?]);
        }
        let at = self.recorded_at(identity.clone()).await?;
        let (id, child) = binding_child(
            &scope.turn_id,
            &scope.session_id,
            &current.view.work_id,
            1,
            identity,
            &at,
        );
        let mut view = current.view.clone();
        view.updated_at = at;
        let mut refs = current
            .manifest
            .get("bindingRefs")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?
            .clone();
        refs.push(json!({"bindingRevisionId":id,"turnId":scope.turn_id,"revision":1}));
        let mut updates = vec![
            self.manifest_update(super::write::ManifestPublicationInput {
                prior: Some(current),
                view: &view,
                identity,
                binding_refs: Value::Array(refs),
                session_head: true,
                revisions: &codec::revisions(&current.manifest),
                create: false,
            })
            .await?,
        ];
        if let Some(update) = self
            .child_update(
                &view.work_id,
                &id,
                ProjectLedgerRecordKind::Reference,
                "Guided Work Turn binding 1".into(),
                child,
            )
            .await?
        {
            updates.push(update);
        }
        Ok(updates)
    }

    pub(super) async fn heartbeat_update(
        &self,
        current: &Snapshot,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<ProjectLedgerRecordUpdate, BtccError> {
        let mut view = current.view.clone();
        view.updated_at = self.recorded_at(identity.clone()).await?;
        self.manifest_update(super::write::ManifestPublicationInput {
            prior: Some(current),
            view: &view,
            identity,
            binding_refs: current
                .manifest
                .get("bindingRefs")
                .cloned()
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
            session_head: current
                .manifest
                .get("sessionHead")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            revisions: &codec::revisions(&current.manifest),
            create: false,
        })
        .await
    }

    fn binding_identity(
        &self,
        scope: &WorkTurnScope,
        expected: Option<&str>,
        resolved: &str,
    ) -> Result<ProjectWorkOperationIdentity, BtccError> {
        let id = codec::record_id("binding", &format!("{}\0{}\0{resolved}", scope.turn_id, 1));
        let digest = codec::request_digest(
            &json!({
                "scope": {"appProjectId":self.scope.app_project_id,"ledgerProjectId":self.scope.ledger_project_id,"ledgerRoot":self.scope.ledger_root},
                "expectedWorkId":expected, "resolvedWorkId":resolved, "priorBinding":null,
            }),
            &self.shared.ledger.collation,
        )?;
        Ok(ProjectWorkOperationIdentity {
            kind: ProjectWorkOperationKind::BindingRevision,
            id,
            request_sha256: digest,
            mutation_call_id: None,
        })
    }

    pub(super) async fn require_receipt(
        &self,
        identity: ProjectWorkOperationIdentity,
        id: String,
        kind: ProjectLedgerRecordKind,
        parent: Option<String>,
    ) -> Result<(), BtccError> {
        let outcome = self.publish(identity, || async { Ok(None) }, true).await?;
        if outcome.skipped
            || !outcome
                .targets
                .iter()
                .any(|item| item.id == id && item.kind == kind && item.parent_id == parent)
        {
            return Err(invalid("project_work_occurrence_receipt_missing"));
        }
        Ok(())
    }

    async fn require_bound_relation(
        &self,
        scope: &WorkTurnScope,
        head: Option<&Snapshot>,
        binding: &Snapshot,
    ) -> Result<Snapshot, BtccError> {
        if head.is_none_or(|head| head.view.work_id != binding.view.work_id) {
            return Err(invalid("project_work_turn_binding_stale"));
        }
        let current = self.require_current(&binding.view.work_id).await?;
        if !is_open(&current.view)
            || current.view.session_id != scope.session_id
            || binding_ref(&current, &scope.turn_id).is_err()
        {
            return Err(invalid("project_work_turn_binding_stale"));
        }
        Ok(current)
    }
}

fn binding_ref(snapshot: &Snapshot, turn_id: &str) -> Result<String, BtccError> {
    snapshot
        .manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("turnId").and_then(Value::as_str) == Some(turn_id))
        })
        .and_then(|item| item.get("bindingRevisionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid("project_work_turn_binding_missing"))
}
