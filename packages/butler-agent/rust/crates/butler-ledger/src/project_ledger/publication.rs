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

use butler_turn::btcc::{ProjectWorkOperationIdentity, ResolvedProjectWorkScope};

pub(crate) use contracts::{ProjectLedgerRecordKind, ProjectLedgerRecordOperation};
pub use contracts::{
    ProjectLedgerRecordUpdate, ProjectWorkPublicationError, ProjectWorkPublicationOutcome,
};
pub use generic::{LedgerEffectError, LedgerEffectReconciliation, LedgerEffectRequest};
pub(super) use init::with_mutation_claim;

pub(super) use generic::{apply as apply_record_effect, reconcile as reconcile_record_effect};

/// Publishes one Project Work operation exactly once. An operation with an
/// occurrence already on disk is reconciled and resumed; a new one prepares
/// its updates, is admitted, and applied.
pub(super) async fn publish<F, Fut>(
    data_root: std::path::PathBuf,
    fs_permits: Arc<Semaphore>,
    collation: Arc<butler_core::locale::LocaleCollation>,
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
    let publisher = Publisher {
        data_root,
        fs_permits,
        collation,
        scope,
        identity,
    };
    match existing {
        Some(existing) => publisher.resume(existing, prepare_updates).await,
        None => publisher.admit(prepare_updates).await,
    }
}

/// One operation's publication on the Ledger's filesystem lane.
struct Publisher {
    data_root: std::path::PathBuf,
    fs_permits: Arc<Semaphore>,
    collation: Arc<butler_core::locale::LocaleCollation>,
    scope: ResolvedProjectWorkScope,
    identity: ProjectWorkOperationIdentity,
}

impl Publisher {
    /// An operation seen before: replay what was applied, finish what was
    /// admitted, or append a new attempt when the earlier one provably did
    /// not apply.
    async fn resume<F, Fut>(
        self,
        existing: occurrence::Occurrence,
        prepare_updates: F,
    ) -> Result<ProjectWorkPublicationOutcome, ProjectWorkPublicationError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<
            Output = Result<Option<Vec<ProjectLedgerRecordUpdate>>, ProjectWorkPublicationError>,
        >,
    {
        let state = fs_phase(Arc::clone(&self.fs_permits), {
            let data_root = self.data_root.clone();
            let existing = existing.clone();
            move || transaction::reconcile(&data_root, &existing)
        })
        .await?;
        let targets = match state {
            transaction::Reconciled::Applied(targets) => targets,
            transaction::Reconciled::Ready => {
                let Self {
                    data_root,
                    fs_permits,
                    collation,
                    scope,
                    ..
                } = self;
                fs_phase(fs_permits, move || {
                    transaction::apply(&data_root, &scope, &existing, None, &collation)
                })
                .await?
            }
            transaction::Reconciled::NotAppliedWithReceipt => {
                let updates = required_updates(prepare_updates().await?)?;
                let Some(updates) = updates else {
                    return Ok(ProjectWorkPublicationOutcome::skipped());
                };
                return self.apply(Some(existing), updates).await;
            }
            transaction::Reconciled::NotApplied => {
                return Err(ProjectWorkPublicationError::NotApplied);
            }
        };
        Ok(ProjectWorkPublicationOutcome {
            replayed: true,
            skipped: false,
            targets,
        })
    }

    /// A new operation: prepare its updates, admit and apply them.
    async fn admit<F, Fut>(
        self,
        prepare_updates: F,
    ) -> Result<ProjectWorkPublicationOutcome, ProjectWorkPublicationError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<
            Output = Result<Option<Vec<ProjectLedgerRecordUpdate>>, ProjectWorkPublicationError>,
        >,
    {
        let updates = required_updates(prepare_updates().await?)?;
        let Some(updates) = updates else {
            return Ok(ProjectWorkPublicationOutcome::skipped());
        };
        self.apply(None, updates).await
    }

    /// Admits `updates` as the first attempt, or appends them after the
    /// previous occurrence, then applies them.
    async fn apply(
        self,
        previous: Option<occurrence::Occurrence>,
        updates: Vec<ProjectLedgerRecordUpdate>,
    ) -> Result<ProjectWorkPublicationOutcome, ProjectWorkPublicationError> {
        let Self {
            data_root,
            fs_permits,
            collation,
            scope,
            identity,
        } = self;
        let targets = fs_phase(fs_permits, move || {
            let attempt = match &previous {
                Some(previous) => occurrence::append(
                    &data_root, &scope, &identity, previous, &updates, &collation,
                )?,
                None => occurrence::admit(&data_root, &scope, &identity, &updates, &collation)?,
            };
            transaction::apply(&data_root, &scope, &attempt, Some(&updates), &collation)
        })
        .await?;
        Ok(ProjectWorkPublicationOutcome {
            replayed: false,
            skipped: false,
            targets,
        })
    }
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
    let permit = permits.acquire_owned().await.map_err(|source| {
        ProjectWorkPublicationError::Owner("project_ledger_closed").with_source(source)
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        phase()
    })
    .await
    .map_err(|source| {
        ProjectWorkPublicationError::Owner("project_ledger_worker_failed").with_source(source)
    })?
}

fn required_updates(
    updates: Option<Vec<ProjectLedgerRecordUpdate>>,
) -> Result<Option<Vec<ProjectLedgerRecordUpdate>>, ProjectWorkPublicationError> {
    if updates.as_ref().is_some_and(Vec::is_empty) {
        return Err(ProjectWorkPublicationError::adapter(
            "project_work_publication_empty",
        ));
    }
    Ok(updates)
}
