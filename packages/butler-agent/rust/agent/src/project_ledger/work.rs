//! Canonical Project Ledger Work repository over shared Ledger and BTCC owners.

mod abandonment;
mod binding;
mod closeout;
mod codec;
mod legacy;
mod progress;
mod publication;
mod relation;
mod snapshot;
mod start;
mod write;

pub(super) use snapshot::{
    read_current as read_current_project_work, validate_publication_candidate,
};

use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use crate::btcc::{
    BtccError, CheckpointCommand, ClaimCloseoutCorrectionInput, ContinueWorkCommand,
    DispositionCommand, DurableWorkRepository, LegacyImport, PortFuture, ProjectWorkLegacyRuntime,
    ProjectWorkResultRuntime, ProjectWorkRuntimeProjection, ReplacePlanCommand,
    ResolvedProjectWorkScope, ReviewCommand, StartWorkCommand, WorkContext, WorkTurnScope,
    WorkView,
};

use super::NativeProjectLedger;

fn invalid(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}

pub(crate) struct NativeProjectWork {
    shared: Arc<Shared>,
}

struct Shared {
    ledger: NativeProjectLedger,
    projection: Arc<dyn ProjectWorkRuntimeProjection>,
    results: Arc<dyn ProjectWorkResultRuntime>,
    legacy: Arc<dyn ProjectWorkLegacyRuntime>,
    mutations: MutationOwner,
}

#[derive(Clone)]
struct ProjectWorkRepository {
    shared: Arc<Shared>,
    scope: ResolvedProjectWorkScope,
}

#[derive(Clone)]
struct MutationOwner(Arc<MutationState>);

struct MutationState {
    closing: Mutex<bool>,
    tasks: TaskTracker,
}

impl NativeProjectWork {
    pub(crate) fn new(
        ledger: NativeProjectLedger,
        projection: Arc<dyn ProjectWorkRuntimeProjection>,
        results: Arc<dyn ProjectWorkResultRuntime>,
        legacy: Arc<dyn ProjectWorkLegacyRuntime>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                ledger,
                projection,
                results,
                legacy,
                mutations: MutationOwner(Arc::new(MutationState {
                    closing: Mutex::new(false),
                    tasks: TaskTracker::new(),
                })),
            }),
        }
    }

    pub(crate) fn repository(
        &self,
        scope: ResolvedProjectWorkScope,
    ) -> Arc<dyn DurableWorkRepository> {
        Arc::new(ProjectWorkRepository {
            shared: self.shared.clone(),
            scope,
        })
    }

    pub(crate) async fn close(&self) {
        self.shared.mutations.close().await;
    }
}

impl MutationOwner {
    async fn run<T: Send + 'static>(
        &self,
        operation: impl std::future::Future<Output = Result<T, BtccError>> + Send + 'static,
    ) -> Result<T, BtccError> {
        let (send, receive) = oneshot::channel();
        {
            let closing = self.0.closing.lock().expect("Project Work owner poisoned");
            if *closing {
                return Err(BtccError::new(
                    "project_work_closed",
                    "Project Work owner is closed",
                ));
            }
            self.0.tasks.spawn(async move {
                let _ = send.send(operation.await);
            });
        }
        receive.await.map_err(|_| {
            BtccError::new("project_work_task_lost", "Project Work operation stopped")
        })?
    }

    async fn close(&self) {
        {
            let mut closing = self.0.closing.lock().expect("Project Work owner poisoned");
            *closing = true;
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }
}

impl DurableWorkRepository for ProjectWorkRepository {
    fn load_context(&self, scope: WorkTurnScope) -> PortFuture<'_, Option<WorkContext>> {
        Box::pin(async move { self.load_context_impl(scope).await })
    }
    fn import_open_legacy_work(
        &self,
        scope: WorkTurnScope,
    ) -> PortFuture<'_, Option<LegacyImport>> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.import_legacy_impl(scope).await })
                .await
        })
    }
    fn bind_open_work(
        &self,
        scope: WorkTurnScope,
        expected: Option<String>,
    ) -> PortFuture<'_, Option<WorkView>> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.bind_open_impl(scope, expected).await })
                .await
        })
    }
    fn start_work(&self, command: StartWorkCommand) -> PortFuture<'_, WorkView> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.start_impl(command).await })
                .await
        })
    }
    fn continue_work(&self, command: ContinueWorkCommand) -> PortFuture<'_, WorkView> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.continue_impl(command).await })
                .await
        })
    }
    fn replace_plan(&self, command: ReplacePlanCommand) -> PortFuture<'_, WorkView> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.replace_plan_impl(command).await })
                .await
        })
    }
    fn record_checkpoint(&self, command: CheckpointCommand) -> PortFuture<'_, WorkView> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.checkpoint_impl(command).await })
                .await
        })
    }
    fn record_review(&self, command: ReviewCommand) -> PortFuture<'_, WorkView> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.review_impl(command).await })
                .await
        })
    }
    fn record_disposition(&self, command: DispositionCommand) -> PortFuture<'_, WorkView> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.disposition_impl(command).await })
                .await
        })
    }
    fn claim_closeout_correction(
        &self,
        input: ClaimCloseoutCorrectionInput,
    ) -> PortFuture<'_, bool> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.claim_closeout_impl(input).await })
                .await
        })
    }
    fn bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move { self.bound_for_turn_impl(turn_id).await })
    }
    fn abandon_bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        let repo = self.clone();
        let owner = self.shared.mutations.clone();
        Box::pin(async move {
            owner
                .run(async move { repo.abandon_for_turn_impl(turn_id).await })
                .await
        })
    }
}
