use std::collections::HashSet;
use std::future::Future;

use serde_json::Value;

use crate::btcc::{
    BtccError, ProjectWorkBinding, ProjectWorkObserveWork, ProjectWorkObserveWorks,
    ProjectWorkOperationIdentity, ProjectWorkOperationKind,
};

use super::super::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
    ProjectWorkPublicationOutcome,
};
use super::codec::Snapshot;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn publish<F, Fut>(
        &self,
        identity: ProjectWorkOperationIdentity,
        prepare: F,
        recover_projection: bool,
    ) -> Result<ProjectWorkPublicationOutcome, BtccError>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<Vec<ProjectLedgerRecordUpdate>>, BtccError>>
            + Send
            + 'static,
    {
        let outcome = self
            .shared
            .ledger
            .publish_work_records(self.scope.clone(), identity.clone(), move || async move {
                prepare().await.map_err(ProjectWorkPublicationError::Work)
            })
            .await
            .map_err(publication_error)?;
        if !outcome.skipped && recover_projection {
            let mut work_ids = Vec::new();
            let mut seen = HashSet::new();
            for target in &outcome.targets {
                if target.kind == ProjectLedgerRecordKind::Work {
                    if seen.insert(target.id.clone()) {
                        work_ids.push(target.id.clone());
                    }
                } else if let Some(parent) = &target.parent_id
                    && seen.insert(parent.clone())
                {
                    work_ids.push(parent.clone());
                }
            }
            self.observe_stable(work_ids, &identity).await?;
        }
        Ok(outcome)
    }

    async fn observe_stable(
        &self,
        ids: Vec<String>,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<(), BtccError> {
        for attempt in 1..=3 {
            let before = self.source_version(Some(ids.clone())).await?;
            let mut affected = Vec::with_capacity(ids.len());
            for id in &ids {
                affected.push(self.require_current(id).await?);
            }
            let mut heads = Vec::new();
            let mut sessions = HashSet::new();
            for item in &affected {
                if sessions.insert(item.view.session_id.clone()) {
                    let head = if item.manifest.get("sessionHead").and_then(Value::as_bool)
                        == Some(true)
                    {
                        item.clone()
                    } else {
                        self.relation_from_ids(&item.view.session_id, None, None)
                            .await?
                            .head
                            .ok_or_else(|| invalid("project_work_session_head_invalid"))?
                    };
                    heads.push((item.view.session_id.clone(), head));
                }
            }
            let after = self.source_version(Some(ids.clone())).await?;
            if before != after {
                if attempt == 3 {
                    return Err(invalid("project_work_snapshot_unstable"));
                }
                continue;
            }
            for (session_id, head) in heads {
                let mut snapshots = affected
                    .iter()
                    .filter(|item| item.view.session_id == session_id)
                    .cloned()
                    .collect::<Vec<_>>();
                if !snapshots
                    .iter()
                    .any(|item| item.view.work_id == head.view.work_id)
                {
                    snapshots.push(head.clone());
                }
                let works = snapshots
                    .into_iter()
                    .map(observed_work)
                    .collect::<Result<Vec<_>, _>>()?;
                self.shared
                    .projection
                    .observe_canonical_works(ProjectWorkObserveWorks {
                        works,
                        session_head_work_id: head.view.work_id,
                        ledger_project_id: self.scope.ledger_project_id.clone(),
                        canonical_head_sha256: after.clone(),
                        legacy_import_claim_work_id: (identity.kind
                            == ProjectWorkOperationKind::LegacyImport
                            && ids.len() == 1)
                            .then(|| ids[0].clone()),
                    })
                    .await?;
            }
            return Ok(());
        }
        Err(invalid("project_work_snapshot_unstable"))
    }
}

fn observed_work(snapshot: Snapshot) -> Result<ProjectWorkObserveWork, BtccError> {
    let current_refs = snapshot
        .manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
    let mut bindings = Vec::new();
    for binding_ref in current_refs {
        let id = binding_ref
            .get("bindingRevisionId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
        let child = snapshot
            .children
            .get(id)
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
        if child.get("schema").and_then(Value::as_str)
            != Some("butler.btcc-project-work-binding.v1")
        {
            continue;
        }
        let binding = child
            .get("binding")
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
        let mut value = binding.clone();
        value["isCurrent"] = Value::Bool(
            current_refs
                .iter()
                .any(|item| item.get("bindingRevisionId") == binding.get("bindingRevisionId")),
        );
        bindings.push(
            serde_json::from_value::<ProjectWorkBinding>(value)
                .map_err(|_| invalid("project_work_managed_record_invalid"))?,
        );
    }
    Ok(ProjectWorkObserveWork {
        work: snapshot.view,
        bindings,
    })
}

pub(super) fn publication_error(error: ProjectWorkPublicationError) -> BtccError {
    match error {
        ProjectWorkPublicationError::Work(error) => error,
        other => BtccError::new(other.code(), other.code()),
    }
}

pub(super) fn published_work_id(outcome: &ProjectWorkPublicationOutcome) -> Option<String> {
    let ids = outcome
        .targets
        .iter()
        .filter_map(|target| {
            if target.kind == ProjectLedgerRecordKind::Work {
                Some(target.id.clone())
            } else {
                target.parent_id.clone()
            }
        })
        .collect::<HashSet<_>>();
    (ids.len() == 1).then(|| ids.into_iter().next()).flatten()
}
