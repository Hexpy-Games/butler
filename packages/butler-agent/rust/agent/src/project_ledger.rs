//! Native committed Project Ledger record reads for Guided Turns.

mod active_reference;
mod briefing_signals;
mod commands;
mod committed;
mod dashboard;
mod legacy_work_source;
mod project_work_plan;
mod publication;
mod records;
mod result_authority;
mod source_head;
#[cfg(test)]
mod tests;
mod tool_scope;
mod work;
mod work_json;
mod work_scope;

use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Notify, Semaphore};

use crate::btcc::{ProjectWorkOperationIdentity, ResolvedProjectWorkScope};
use crate::locale::LocaleCollation;

tokio::task_local! {
    static IN_PUBLICATION: ();
}

pub(crate) use briefing_signals::{ProjectBriefingSignal, ProjectBriefingTarget};
pub(crate) use commands::{LedgerCommand, LedgerCommandRequest};
pub(crate) use dashboard::{
    DashboardLedgerHistory, DashboardLedgerRecord, DashboardLedgerSnapshot, DashboardLedgerSource,
    DashboardManagedWorkView, DashboardWorkHistoryEntry, ProjectLedgerBinding,
};
pub(crate) use project_work_plan::{ProjectWorkPlanFacts, ProjectWorkPlanRead};
pub(crate) use publication::{
    LedgerEffectError, LedgerEffectReconciliation, LedgerEffectRequest, ProjectLedgerRecordUpdate,
    ProjectWorkPublicationError, ProjectWorkPublicationOutcome,
};
pub(crate) use records::PlanRecordShow;
pub(crate) use result_authority::prepare_exact_project_work_result_authority;
pub(crate) use tool_scope::ProjectLedgerToolScopeLookup;
pub(crate) use work::NativeProjectWork;
pub(crate) use work_scope::ProjectWorkScopeLookup;

/// Failures of Project Ledger reads. `code()` is the wire code; `source`
/// keeps the file, JSON or task error behind the failure when there was one.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum ProjectLedgerReadError {
    /// The project or work item could not be resolved.
    #[error("{code}")]
    Resolution {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// A ledger record could not be read or is malformed.
    #[error("{code}")]
    RecordShow {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The read owner is closed or its task failed.
    #[error("{code}")]
    Owner {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// A dashboard projection failed internally.
    #[error("{code}")]
    DashboardInternal {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// Dashboard inputs are unavailable.
    #[error("{code}")]
    DashboardUnavailable {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The ledger changed while the dashboard was being read.
    #[error("project_ledger_changed")]
    DashboardChanged,
}

impl ProjectLedgerReadError {
    pub(crate) fn resolution(code: &'static str) -> Self {
        Self::Resolution { code, source: None }
    }

    pub(crate) fn record_show(code: &'static str) -> Self {
        Self::RecordShow { code, source: None }
    }

    pub(crate) fn owner(code: &'static str) -> Self {
        Self::Owner { code, source: None }
    }

    pub(crate) fn dashboard_internal(code: &'static str) -> Self {
        Self::DashboardInternal { code, source: None }
    }

    pub(crate) fn dashboard_unavailable(code: &'static str) -> Self {
        Self::DashboardUnavailable { code, source: None }
    }

    /// The wire code.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Resolution { code, .. }
            | Self::RecordShow { code, .. }
            | Self::Owner { code, .. }
            | Self::DashboardInternal { code, .. }
            | Self::DashboardUnavailable { code, .. } => code,
            Self::DashboardChanged => "project_ledger_changed",
        }
    }

    /// Records `cause` as the source when none is recorded yet.
    #[must_use]
    pub(crate) fn with_source(
        mut self,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        if let Self::Resolution { source, .. }
        | Self::RecordShow { source, .. }
        | Self::Owner { source, .. }
        | Self::DashboardInternal { source, .. }
        | Self::DashboardUnavailable { source, .. } = &mut self
            && source.is_none()
        {
            *source = Some(Arc::new(cause));
        }
        self
    }
}

/// Wire equality: the same variant and code (causes are diagnostic only).
impl PartialEq for ProjectLedgerReadError {
    fn eq(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other) && self.code() == other.code()
    }
}

impl Eq for ProjectLedgerReadError {}

#[derive(Clone, Debug)]
pub(crate) struct PlanRecordRead {
    pub workspace_path: String,
    pub app_project_id: String,
    pub plan_id: String,
}

#[derive(Clone)]
pub(crate) struct NativeProjectLedger {
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

impl NativeProjectLedger {
    pub(crate) async fn briefing_signals(
        &self,
        targets: Option<Vec<ProjectBriefingTarget>>,
        consolidation_root: PathBuf,
    ) -> Result<Vec<ProjectBriefingSignal>, ProjectLedgerReadError> {
        self.run(move |root, collation| {
            briefing_signals::read(root, collation, targets.as_deref(), &consolidation_root)
        })
        .await
    }
    #[cfg(test)]
    pub(crate) fn new(butler_data: &Path, max_blocking_reads: usize) -> Self {
        Self::with_collation(
            butler_data,
            max_blocking_reads,
            Arc::new(LocaleCollation::new("en-US").expect("supported locale")),
        )
    }

    pub(crate) fn with_collation(
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

    pub(crate) async fn show_plan_record(
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
    pub(crate) async fn resolve_app_plan_root(
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

    pub(crate) async fn dashboard_snapshot(
        &self,
        binding: ProjectLedgerBinding,
    ) -> Result<DashboardLedgerSnapshot, ProjectLedgerReadError> {
        self.run(move |root, collation| dashboard::snapshot(root, &binding, collation))
            .await
    }

    pub(crate) async fn read_dashboard_source(
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

    pub(crate) async fn dashboard_work_history_for_revision(
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

    pub(crate) async fn read_dashboard_ledger_history(
        &self,
        ledger_project_id: String,
    ) -> Result<DashboardLedgerHistory, ProjectLedgerReadError> {
        self.run(move |root, _| dashboard::read_ledger_history(root, &ledger_project_id))
            .await
    }

    pub(crate) async fn read_project_work_plan(
        &self,
        input: ProjectWorkPlanRead,
    ) -> Result<Option<ProjectWorkPlanFacts>, ProjectLedgerReadError> {
        self.run(move |root, collation| project_work_plan::read(root, &input, collation))
            .await
    }

    pub(crate) async fn find_canonical_record_kinds(
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
    pub(crate) async fn execute_command(
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

    pub(crate) async fn ensure_project_ledger(
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

    pub(crate) async fn apply_record_effect(
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

    pub(crate) async fn reconcile_record_effect(
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

    pub(crate) async fn close(&self) {
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
