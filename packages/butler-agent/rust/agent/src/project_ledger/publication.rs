//! Canonical Project Work publication on the Project Ledger owner.

mod contracts;
mod generic;
mod init;
mod occurrence;
mod record;
mod transaction;

use std::future::Future;
use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::btcc::{ProjectWorkOperationIdentity, ResolvedProjectWorkScope};

pub(crate) use contracts::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
    ProjectWorkPublicationError, ProjectWorkPublicationOutcome,
};
pub(crate) use generic::{LedgerEffectError, LedgerEffectReconciliation, LedgerEffectRequest};
pub(super) use init::with_mutation_claim;

pub(super) use generic::{apply as apply_record_effect, reconcile as reconcile_record_effect};

pub(super) async fn publish<F, Fut>(
    data_root: std::path::PathBuf,
    fs_permits: Arc<Semaphore>,
    collation: Arc<crate::locale::LocaleCollation>,
    scope: ResolvedProjectWorkScope,
    identity: ProjectWorkOperationIdentity,
    prepare_updates: F,
) -> Result<ProjectWorkPublicationOutcome, ProjectWorkPublicationError>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<Option<Vec<ProjectLedgerRecordUpdate>>, ProjectWorkPublicationError>>
        + Send
        + 'static,
{
    let (scope, existing) = fs_phase(Arc::clone(&fs_permits), {
        let data_root = data_root.clone();
        let identity = identity.clone();
        move || {
            let original_root = scope.ledger_root.clone();
            let scope = record::resolve_scope(&data_root, scope)?;
            occurrence::reject_legacy(
                &data_root,
                &original_root,
                &scope.ledger_root,
                &identity.id,
            )?;
            let existing = occurrence::read(&data_root, &scope, &identity)?;
            Ok((scope, existing))
        }
    })
    .await?;
    if let Some(existing) = existing {
        let state = fs_phase(Arc::clone(&fs_permits), {
            let data_root = data_root.clone();
            let existing = existing.clone();
            move || transaction::reconcile(&data_root, &existing)
        })
        .await?;
        match state {
            transaction::Reconciled::Applied(targets) => {
                return Ok(ProjectWorkPublicationOutcome {
                    replayed: true,
                    skipped: false,
                    targets,
                });
            }
            transaction::Reconciled::Ready => {
                let targets = fs_phase(Arc::clone(&fs_permits), {
                    let data_root = data_root.clone();
                    let scope = scope.clone();
                    let collation = Arc::clone(&collation);
                    move || transaction::apply(&data_root, &scope, &existing, None, &collation)
                })
                .await?;
                return Ok(ProjectWorkPublicationOutcome {
                    replayed: true,
                    skipped: false,
                    targets,
                });
            }
            transaction::Reconciled::NotAppliedWithReceipt => {
                let updates = required_updates(prepare_updates().await?)?;
                let Some(updates) = updates else {
                    return Ok(ProjectWorkPublicationOutcome::skipped());
                };
                let targets = fs_phase(Arc::clone(&fs_permits), {
                    let data_root = data_root.clone();
                    let scope = scope.clone();
                    let identity = identity.clone();
                    let collation = Arc::clone(&collation);
                    move || {
                        let attempt = occurrence::append(
                            &data_root, &scope, &identity, &existing, &updates, &collation,
                        )?;
                        let targets = transaction::apply(
                            &data_root,
                            &scope,
                            &attempt,
                            Some(&updates),
                            &collation,
                        )?;
                        Ok(targets)
                    }
                })
                .await?;
                return Ok(ProjectWorkPublicationOutcome {
                    replayed: false,
                    skipped: false,
                    targets,
                });
            }
            transaction::Reconciled::NotApplied => {
                return Err(ProjectWorkPublicationError::NotApplied);
            }
        }
    }
    let updates = required_updates(prepare_updates().await?)?;
    let Some(updates) = updates else {
        return Ok(ProjectWorkPublicationOutcome::skipped());
    };
    let targets = fs_phase(fs_permits, {
        let collation = Arc::clone(&collation);
        move || {
            let attempt = occurrence::admit(&data_root, &scope, &identity, &updates, &collation)?;
            let targets =
                transaction::apply(&data_root, &scope, &attempt, Some(&updates), &collation)?;
            Ok(targets)
        }
    })
    .await?;
    Ok(ProjectWorkPublicationOutcome {
        replayed: false,
        skipped: false,
        targets,
    })
}

pub(super) async fn ensure(
    data_root: std::path::PathBuf,
    fs_permits: Arc<Semaphore>,
    scope: ResolvedProjectWorkScope,
    display_name: String,
) -> Result<(), ProjectWorkPublicationError> {
    fs_phase(fs_permits, move || {
        init::ensure(&data_root, &scope, &display_name)
    })
    .await
}

async fn fs_phase<T: Send + 'static>(
    permits: Arc<Semaphore>,
    phase: impl FnOnce() -> Result<T, ProjectWorkPublicationError> + Send + 'static,
) -> Result<T, ProjectWorkPublicationError> {
    let permit = permits
        .acquire_owned()
        .await
        .map_err(|_| ProjectWorkPublicationError::Owner("project_ledger_closed"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        phase()
    })
    .await
    .map_err(|_| ProjectWorkPublicationError::Owner("project_ledger_worker_failed"))?
}

fn required_updates(
    updates: Option<Vec<ProjectLedgerRecordUpdate>>,
) -> Result<Option<Vec<ProjectLedgerRecordUpdate>>, ProjectWorkPublicationError> {
    if updates.as_ref().is_some_and(Vec::is_empty) {
        return Err(ProjectWorkPublicationError::Adapter(
            "project_work_publication_empty",
        ));
    }
    Ok(updates)
}
