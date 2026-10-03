//! Committed Project Ledger records and project-scoped Work for guided turns.

mod active_reference;
mod briefing_signals;
mod commands;
mod committed;
mod dashboard;
mod events;
mod project_work_plan;
mod publication;
mod records;
mod result_authority;
mod source_head;
mod status;
/// The Bun source-plan fixture, shared with tests of dependent crates.
#[cfg(any(test, feature = "test-support"))]
pub const SOURCE_PLAN_FIXTURE: &str = include_str!("project_ledger/tests/source-plan.json");
#[cfg(test)]
mod tests;
mod tool_scope;
mod work;
mod work_json;
mod work_model;
mod work_scope;

use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Notify, Semaphore};

use butler_core::locale::LocaleCollation;
use butler_turn::btcc::{ProjectWorkOperationIdentity, ResolvedProjectWorkScope};

tokio::task_local! {
    static IN_PUBLICATION: ();
}

pub use briefing_signals::{ProjectBriefingSignal, ProjectBriefingTarget};
pub use commands::{LedgerCommand, LedgerCommandRequest};
pub use dashboard::{
    DashboardLedgerHistory, DashboardLedgerRecord, DashboardLedgerSnapshot, DashboardLedgerSource,
    DashboardManagedWorkView, DashboardWorkHistoryEntry, ProjectLedgerBinding,
};
pub use project_work_plan::{ProjectWorkPlanFacts, ProjectWorkPlanRead};
pub use publication::{
    LedgerEffectError, LedgerEffectReconciliation, LedgerEffectRequest, ProjectLedgerRecordUpdate,
    ProjectWorkPublicationError, ProjectWorkPublicationOutcome, ProjectWorkTarget,
    ProjectWorkTargetState, RecordEvidence, RecordSections,
};
pub(crate) use records::PlanRecordShow;
pub use result_authority::prepare_exact_project_work_result_authority;
pub use tool_scope::ProjectLedgerToolScopeLookup;
mod legacy;
mod read_error;
pub use read_error::ProjectLedgerReadError;
pub use work::ProjectWork;
pub use work_scope::ProjectWorkScopeLookup;

/// A request to show one plan of the project a workspace resolves to.
#[derive(Clone, Debug)]
pub struct PlanRecordRead {
    /// The workspace whose project identifies the Ledger.
    pub workspace_path: String,
    /// The App project id, the fallback Ledger id.
    pub app_project_id: String,
    /// The plan id to show.
    pub plan_id: String,
}

/// The owner of every Project Ledger under one Butler data root: reads run
/// on bounded blocking permits, publications one at a time, and `close`
/// waits for everything admitted.
#[derive(Clone)]
pub struct ProjectLedger {
    data_root: PathBuf,
    owner: Arc<ReadOwner>,
    collation: Arc<LocaleCollation>,
}

struct ReadOwner {
    permits: Arc<Semaphore>,
    publication_permits: Arc<Semaphore>,
    state: Mutex<OwnerState>,
    idle: Notify,
}

struct OwnerState {
    closing: bool,
    active: usize,
}

struct ActiveRead(Arc<ReadOwner>);

impl Drop for ActiveRead {
    fn drop(&mut self) {
        let mut state = self.0.state.lock();
        state.active -= 1;
        drop(state);
        self.0.idle.notify_waiters();
    }
}

impl ProjectLedger {
    /// Briefing signals for `targets`, or for every Ledger when `None`.
    pub async fn briefing_signals(
        &self,
        targets: Option<Vec<ProjectBriefingTarget>>,
        consolidation_root: PathBuf,
    ) -> Result<Vec<ProjectBriefingSignal>, ProjectLedgerReadError> {
        self.run(move |root, collation| {
            briefing_signals::read(root, collation, targets.as_deref(), &consolidation_root)
        })
        .await
    }
    /// A test owner comparing text in en-US.
    #[cfg(any(test, feature = "test-support"))]
    pub fn new(butler_data: &Path, max_blocking_reads: usize) -> Self {
        Self::with_collation(
            butler_data,
            max_blocking_reads,
            Arc::new(LocaleCollation::new("en-US").expect("supported locale")),
        )
    }

    /// An owner over `butler_data` running at most `max_blocking_reads` reads
    /// at once, comparing text with `collation`.
    pub fn with_collation(
        butler_data: &Path,
        max_blocking_reads: usize,
        collation: Arc<LocaleCollation>,
    ) -> Self {
        Self {
            data_root: butler_data.to_path_buf(),
            collation,
            owner: Arc::new(ReadOwner {
                permits: Arc::new(Semaphore::new(max_blocking_reads.max(1))),
                publication_permits: Arc::new(Semaphore::new(1)),
                state: Mutex::new(OwnerState {
                    closing: false,
                    active: 0,
                }),
                idle: Notify::new(),
            }),
        }
    }

    /// The plan `input` names, as the Bun record reader shows it.
    pub async fn show_plan_record(
        &self,
        input: PlanRecordRead,
    ) -> Result<PlanRecordShow, ProjectLedgerReadError> {
        self.run(move |root, _| {
            let project = active_reference::resolve(root, &input)?;
            records::show_plan(root, &project, &input.plan_id)
        })
        .await
    }

    /// Resolve an App-owned Project Ledger reference before a Plan decision.
    pub async fn resolve_app_plan_root(
        &self,
        app_project_id: String,
        ledger_project_id: String,
    ) -> Result<PathBuf, ProjectLedgerReadError> {
        self.run(move |root, _| {
            active_reference::resolve_reference(
                root,
                None,
                &app_project_id,
                Some(&ledger_project_id),
            )
        })
        .await
    }

    /// The dashboard snapshot of the bound Ledger.
    pub async fn dashboard_snapshot(
        &self,
        binding: ProjectLedgerBinding,
    ) -> Result<DashboardLedgerSnapshot, ProjectLedgerReadError> {
        self.run(move |root, collation| dashboard::snapshot(root, &binding, collation))
            .await
    }

    /// One dashboard source document, if the snapshot is still at
    /// `expected_revision` (or the source is).
    pub async fn read_dashboard_source(
        &self,
        binding: ProjectLedgerBinding,
        kind: String,
        id: String,
        expected_revision: String,
    ) -> Result<DashboardLedgerSource, ProjectLedgerReadError> {
        self.run(move |root, collation| {
            dashboard::read_source(root, &binding, &kind, &id, &expected_revision, collation)
        })
        .await
    }

    /// The managed Work history, if the snapshot is still at
    /// `expected_snapshot_revision`.
    pub async fn dashboard_work_history_for_revision(
        &self,
        binding: ProjectLedgerBinding,
        expected_snapshot_revision: String,
        work_id: Option<String>,
    ) -> Result<Vec<DashboardWorkHistoryEntry>, ProjectLedgerReadError> {
        self.run(move |root, collation| {
            let snapshot = dashboard::snapshot(root, &binding, collation)?;
            if snapshot.revision != expected_snapshot_revision {
                return Err(ProjectLedgerReadError::DashboardChanged);
            }
            dashboard::work_history(root, &binding, &snapshot, work_id.as_deref(), collation)
        })
        .await
    }

    /// The Ledger's record event history, newest first.
    pub async fn read_dashboard_ledger_history(
        &self,
        ledger_project_id: String,
    ) -> Result<DashboardLedgerHistory, ProjectLedgerReadError> {
        self.run(move |root, _| dashboard::read_ledger_history(root, &ledger_project_id))
            .await
    }

    /// Plan facts of one managed Work, or `None` without a current plan.
    pub async fn read_project_work_plan(
        &self,
        input: ProjectWorkPlanRead,
    ) -> Result<Option<ProjectWorkPlanFacts>, ProjectLedgerReadError> {
        self.run(move |root, collation| project_work_plan::read(root, &input, collation))
            .await
    }

    /// The distinct kinds of records with this id in the project's index.
    pub async fn find_canonical_record_kinds(
        &self,
        project_root: PathBuf,
        id: String,
    ) -> Result<Vec<String>, ProjectLedgerReadError> {
        self.run(move |data_root, _| {
            commands::canonical_record_kinds(data_root, &project_root, &id).map_err(|()| {
                ProjectLedgerReadError::record_show("project_ledger_record_kinds_unavailable")
            })
        })
        .await
    }

    /// Execute one source Project Ledger command on this owner's tracked FS lane.
    pub async fn execute_command(
        &self,
        request: LedgerCommandRequest,
    ) -> Result<serde_json::Value, ProjectLedgerReadError> {
        let (publication_permit, active) = self.admit_publication().await.map_err(|source| {
            ProjectLedgerReadError::owner("project_ledger_closed").with_source(source)
        })?;
        let fs_permit = self
            .owner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| {
                ProjectLedgerReadError::owner("project_ledger_closed").with_source(source)
            })?;
        let data_root = self.data_root.clone();
        let collation = Arc::clone(&self.collation);
        tokio::task::spawn_blocking(move || {
            let _publication_permit = publication_permit;
            let _active = active;
            let _fs_permit = fs_permit;
            commands::execute_sync(&data_root, &request, &collation)
        })
        .await
        .map_err(|source| {
            ProjectLedgerReadError::owner("project_ledger_worker_failed").with_source(source)
        })
    }

    /// Initializes the scope's Ledger (project file, event log and layout)
    /// once, under the mutation claim.
    pub async fn ensure_project_ledger(
        &self,
        scope: ResolvedProjectWorkScope,
        display_name: String,
    ) -> Result<(), ProjectWorkPublicationError> {
        let (permit, active) = self.admit_publication().await?;
        let root = self.data_root.clone();
        let fs_permits = Arc::clone(&self.owner.permits);
        tokio::spawn(async move {
            let _permit = permit;
            let _active = active;
            IN_PUBLICATION
                .scope(
                    (),
                    publication::ensure(root, fs_permits, scope, display_name),
                )
                .await
        })
        .await
        .map_err(|source| {
            ProjectWorkPublicationError::Owner("project_ledger_worker_failed").with_source(source)
        })?
    }

    pub(crate) async fn publish_work_records<F, Fut>(
        &self,
        scope: ResolvedProjectWorkScope,
        identity: ProjectWorkOperationIdentity,
        prepare_updates: F,
    ) -> Result<ProjectWorkPublicationOutcome, ProjectWorkPublicationError>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<
                Output = Result<
                    Option<Vec<ProjectLedgerRecordUpdate>>,
                    ProjectWorkPublicationError,
                >,
            > + Send
            + 'static,
    {
        let (permit, active) = self.admit_publication().await?;
        let root = self.data_root.clone();
        let fs_permits = Arc::clone(&self.owner.permits);
        let collation = Arc::clone(&self.collation);
        tokio::spawn(async move {
            let _permit = permit;
            let _active = active;
            IN_PUBLICATION
                .scope(
                    (),
                    publication::publish(
                        root,
                        fs_permits,
                        collation,
                        scope,
                        identity,
                        prepare_updates,
                    ),
                )
                .await
        })
        .await
        .map_err(|source| {
            ProjectWorkPublicationError::Owner("project_ledger_worker_failed").with_source(source)
        })?
    }

    /// Applies one generic record effect exactly once and returns its result.
    pub async fn apply_record_effect(
        &self,
        request: LedgerEffectRequest,
    ) -> Result<serde_json::Value, LedgerEffectError> {
        let (publication_permit, active) = self
            .admit_publication()
            .await
            .map_err(|_| LedgerEffectError::Owner("project_ledger_closed"))?;
        let fs_permit = self
            .owner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| LedgerEffectError::Owner("project_ledger_closed"))?;
        let data_root = self.data_root.clone();
        let collation = Arc::clone(&self.collation);
        tokio::task::spawn_blocking(move || {
            let _publication_permit = publication_permit;
            let _active = active;
            let _fs_permit = fs_permit;
            publication::apply_record_effect(&data_root, &request, &collation)
        })
        .await
        .map_err(|_| LedgerEffectError::Owner("project_ledger_worker_failed"))?
    }

    /// Reports whether an effect was applied, without applying it.
    pub async fn reconcile_record_effect(
        &self,
        request: LedgerEffectRequest,
    ) -> Result<LedgerEffectReconciliation, LedgerEffectError> {
        let (publication_permit, active) = self
            .admit_publication()
            .await
            .map_err(|_| LedgerEffectError::Owner("project_ledger_closed"))?;
        let fs_permit = self
            .owner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| LedgerEffectError::Owner("project_ledger_closed"))?;
        let data_root = self.data_root.clone();
        let collation = Arc::clone(&self.collation);
        tokio::task::spawn_blocking(move || {
            let _publication_permit = publication_permit;
            let _active = active;
            let _fs_permit = fs_permit;
            publication::reconcile_record_effect(&data_root, &request, &collation)
        })
        .await
        .map_err(|_| LedgerEffectError::Owner("project_ledger_worker_failed"))?
    }

    async fn admit_publication(
        &self,
    ) -> Result<(tokio::sync::OwnedSemaphorePermit, ActiveRead), ProjectWorkPublicationError> {
        let permit = self
            .owner
            .publication_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| {
                ProjectWorkPublicationError::Owner("project_ledger_closed").with_source(source)
            })?;
        {
            let mut state = self.owner.state.lock();
            if state.closing {
                return Err(ProjectWorkPublicationError::Owner("project_ledger_closed"));
            }
            state.active += 1;
        }
        Ok((permit, ActiveRead(Arc::clone(&self.owner))))
    }

    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Path, &LocaleCollation) -> Result<T, ProjectLedgerReadError> + Send + 'static,
    ) -> Result<T, ProjectLedgerReadError> {
        let permit = self
            .owner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| {
                ProjectLedgerReadError::owner("project_ledger_closed").with_source(source)
            })?;
        {
            let mut state = self.owner.state.lock();
            if state.closing && IN_PUBLICATION.try_with(|()| ()).is_err() {
                return Err(ProjectLedgerReadError::owner("project_ledger_closed"));
            }
            state.active += 1;
        }
        let active = ActiveRead(Arc::clone(&self.owner));
        let root = self.data_root.clone();
        let collation = Arc::clone(&self.collation);
        let task = tokio::task::spawn_blocking(move || {
            let _active = active;
            let _permit = permit;
            work(&root, &collation)
        });
        task.await.map_err(|source| {
            ProjectLedgerReadError::owner("project_ledger_worker_failed").with_source(source)
        })?
    }

    /// Refuses new work and waits until every admitted read and publication
    /// has finished.
    pub async fn close(&self) {
        {
            self.owner.state.lock().closing = true;
        }
        self.owner.publication_permits.close();
        loop {
            let notified = self.owner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.owner.state.lock().active == 0 {
                break;
            }
            notified.await;
        }
    }
}
