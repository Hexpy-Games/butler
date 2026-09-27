use std::collections::HashSet;
use std::future::Future;

use serde_json::Value;

use butler_turn::btcc::{
    BtccError, ProjectWorkBinding, ProjectWorkObserveWork, ProjectWorkObserveWorks,
    ProjectWorkOperationIdentity, ProjectWorkOperationKind,
};

use super::super::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
    ProjectWorkPublicationOutcome, ProjectWorkTarget,
};
use super::codec::Snapshot;
use super::{ProjectWorkRepository, invalid};

/// Whether a publication observes the Work it wrote back into the runtime's
/// projection, or leaves the projection as it is.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Projection {
    Recover,
    Keep,
}

impl ProjectWorkRepository {
    pub(super) async fn publish<F, Fut>(
        &self,
        identity: ProjectWorkOperationIdentity,
        prepare: F,
        projection: Projection,
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
        if !outcome.skipped && projection == Projection::Recover {
            self.observe_stable(affected_work_ids(&outcome.targets), &identity)
                .await?;
        }
        Ok(outcome)
    }

    /// Observes the affected Work and their session heads into the runtime
    /// projection, from a read the Ledger did not change during (at most
    /// three attempts).
    async fn observe_stable(
        &self,
        ids: Vec<String>,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<(), BtccError> {
        for _attempt in 1..=3 {
            let before = self.source_version(Some(ids.clone())).await?;
            let mut affected = Vec::with_capacity(ids.len());
            for id in &ids {
                affected.push(self.require_current(id).await?);
            }
            let heads = self.session_heads(&affected).await?;
            let after = self.source_version(Some(ids.clone())).await?;
            if before != after {
                continue;
            }
            let claim = (identity.kind == ProjectWorkOperationKind::LegacyImport && ids.len() == 1)
                .then(|| ids.first().cloned())
                .flatten();
            for (session_id, head) in heads {
                let works = session_works(&affected, &session_id, &head)?;
                self.shared
                    .projection
                    .observe_canonical_works(ProjectWorkObserveWorks {
                        works,
                        session_head_work_id: head.view.work_id,
                        ledger_project_id: self.scope.ledger_project_id.clone(),
                        canonical_head_sha256: after.clone(),
                        legacy_import_claim_work_id: claim.clone(),
                    })
                    .await?;
            }
            return Ok(());
        }
        Err(invalid("project_work_snapshot_unstable"))
    }

    /// Each affected session's head Work, in first-seen order.
    async fn session_heads(
        &self,
        affected: &[Snapshot],
    ) -> Result<Vec<(String, Snapshot)>, BtccError> {
        let mut heads = Vec::new();
        let mut sessions = HashSet::new();
        for item in affected {
            if !sessions.insert(item.view.session_id.clone()) {
                continue;
            }
            let head = if item.manifest.get("sessionHead").and_then(Value::as_bool) == Some(true) {
                item.clone()
            } else {
                self.relation_from_ids(&item.view.session_id, None, None)
                    .await?
                    .head
                    .ok_or_else(|| invalid("project_work_session_head_invalid"))?
            };
            heads.push((item.view.session_id.clone(), head));
        }
        Ok(heads)
    }
}

/// The affected Work of one session plus its head, as observed Work.
fn session_works(
    affected: &[Snapshot],
    session_id: &str,
    head: &Snapshot,
) -> Result<Vec<ProjectWorkObserveWork>, BtccError> {
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
    snapshots.into_iter().map(observed_work).collect()
}

/// The Work each published target belongs to, without repeats.
fn affected_work_ids(targets: &[ProjectWorkTarget]) -> Vec<String> {
    let mut work_ids = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        let id = if target.kind == ProjectLedgerRecordKind::Work {
            Some(&target.id)
        } else {
            target.parent_id.as_ref()
        };
        if let Some(id) = id
            && seen.insert(id.clone())
        {
            work_ids.push(id.clone());
        }
    }
    work_ids
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
        let is_current = current_refs
            .iter()
            .any(|item| item.get("bindingRevisionId") == binding.get("bindingRevisionId"));
        crate::project_ledger::work_json::set_field(
            &mut value,
            "isCurrent",
            Value::Bool(is_current),
        );
        bindings.push(
            serde_json::from_value::<ProjectWorkBinding>(value).map_err(|source| {
                invalid("project_work_managed_record_invalid").with_source(source)
            })?,
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
        other => BtccError::relayed(other.code().to_owned(), other.code()),
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
