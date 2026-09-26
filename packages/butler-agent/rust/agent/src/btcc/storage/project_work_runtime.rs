//! Project Work's SQLite observation runtime on the existing BTCC actor.

mod legacy;
pub(in crate::btcc) mod material;
mod projection;
mod result;

use std::sync::Arc;

use rusqlite::{Connection, TransactionBehavior};

use crate::btcc::work::{
    LegacyProjectWorkSource, ProjectWorkCapturedMaterial, ProjectWorkCommittedResultInput,
    ProjectWorkDispositionPreparation, ProjectWorkLegacyInput, ProjectWorkLegacyObservation,
    ProjectWorkLegacyObserveInput, ProjectWorkLegacyRuntime, ProjectWorkLegacySnapshot,
    ProjectWorkLocateInput, ProjectWorkMaterialInput, ProjectWorkObserveWorks,
    ProjectWorkOperationIdentity, ProjectWorkResultRuntime, ProjectWorkRuntimeProjection,
    ProjectWorkToolResultEvidence,
};
use crate::btcc::work::{OriginalRequest, WorkResultFact, WorkTurnScope, WorkView};
use crate::btcc::{BtccError, PortFuture};

use super::{BtccStorage, StorageError, StorageResult};

#[derive(Clone)]
pub(crate) struct SqliteProjectWorkRuntime {
    storage: BtccStorage,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
    raw_r2_source: Arc<dyn LegacyProjectWorkSource>,
}

impl SqliteProjectWorkRuntime {
    pub(crate) fn new(
        storage: BtccStorage,
        clock: Arc<dyn Fn() -> String + Send + Sync>,
        raw_r2_source: Arc<dyn LegacyProjectWorkSource>,
    ) -> Self {
        Self {
            storage,
            clock,
            raw_r2_source,
        }
    }

    async fn read<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    ) -> Result<T, BtccError> {
        self.storage
            .execute(move |db| operation(db))
            .await
            .map_err(map_error)
    }

    async fn write<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Connection, &dyn Fn() -> String) -> StorageResult<T> + Send + 'static,
    ) -> Result<T, BtccError> {
        let clock = self.clock.clone();
        self.storage
            .execute(move |db| {
                let transaction = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(StorageError::sqlite)?;
                let value = operation(&transaction, &*clock)?;
                transaction.commit().map_err(StorageError::sqlite)?;
                Ok(value)
            })
            .await
            .map_err(map_error)
    }
}

fn map_error(error: StorageError) -> BtccError {
    BtccError::new(error.code, error.message)
}

impl ProjectWorkRuntimeProjection for SqliteProjectWorkRuntime {
    fn locate_canonical_works(
        &self,
        input: ProjectWorkLocateInput,
    ) -> PortFuture<'_, crate::btcc::work::ProjectWorkCanonicalLocation> {
        Box::pin(async move { self.read(move |db| projection::locate(db, &input)).await })
    }
    fn load_original_request(&self, scope: WorkTurnScope) -> PortFuture<'_, OriginalRequest> {
        Box::pin(async move {
            self.read(move |db| projection::original_request(db, &scope))
                .await
        })
    }
    fn load_result_facts(&self, work_id: String) -> PortFuture<'_, Vec<WorkResultFact>> {
        Box::pin(async move {
            self.read(move |db| projection::result_facts(db, &work_id))
                .await
        })
    }
    fn operation_recorded_at(
        &self,
        identity: ProjectWorkOperationIdentity,
    ) -> PortFuture<'_, String> {
        Box::pin(async move {
            let stored = self
                .read(move |db| projection::operation_recorded_at(db, &identity))
                .await?;
            Ok(stored.unwrap_or_else(|| (self.clock)()))
        })
    }
    fn prepare_disposition(
        &self,
        command: crate::btcc::work::DispositionCommand,
        current: WorkView,
    ) -> PortFuture<'_, ProjectWorkDispositionPreparation> {
        Box::pin(async move {
            self.read(move |db| projection::prepare_disposition(db, &command, &current))
                .await
        })
    }
    fn capture_work_material(
        &self,
        input: ProjectWorkMaterialInput,
    ) -> PortFuture<'_, ProjectWorkCapturedMaterial> {
        Box::pin(async move { self.read(move |db| material::capture(db, &input)).await })
    }
    fn observe_canonical_works(&self, input: ProjectWorkObserveWorks) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.write(move |db, _| result::observe_works(db, &input))
                .await
        })
    }
}

impl ProjectWorkResultRuntime for SqliteProjectWorkRuntime {
    fn read_committed_result(
        &self,
        input: ProjectWorkCommittedResultInput,
    ) -> PortFuture<'_, ProjectWorkToolResultEvidence> {
        Box::pin(async move {
            self.read(move |db| result::read_committed(db, &input))
                .await
        })
    }
}

impl ProjectWorkLegacyRuntime for SqliteProjectWorkRuntime {
    fn read_import_observation(
        &self,
        input: ProjectWorkLegacyInput,
    ) -> PortFuture<'_, Option<ProjectWorkLegacyObservation>> {
        Box::pin(async move {
            self.read(move |db| legacy::import_observation(db, &input))
                .await
        })
    }
    fn capture_stable_snapshot(
        &self,
        input: ProjectWorkLegacyInput,
    ) -> PortFuture<'_, Option<Arc<ProjectWorkLegacySnapshot>>> {
        Box::pin(async move {
            let current = self
                .write({
                    let input = input.clone();
                    move |db, _| legacy::capture_sqlite(db, &input)
                })
                .await?;
            if let Some(current) = current {
                return Ok(Some(Arc::new(current)));
            }
            Ok(legacy::capture_raw_r2(self, &input).await?.map(Arc::new))
        })
    }
    fn revalidate_before_observation(
        &self,
        input: ProjectWorkLegacyInput,
        snapshot: Arc<ProjectWorkLegacySnapshot>,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move { legacy::revalidate(self, input, snapshot).await })
    }
    fn observe_imported(&self, input: ProjectWorkLegacyObserveInput) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.write(move |db, clock| legacy::observe_imported(db, &input, clock))
                .await
        })
    }
}
