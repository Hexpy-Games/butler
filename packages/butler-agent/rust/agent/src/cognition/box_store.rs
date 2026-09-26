//! Native owner for the Cognition Box manifest index and retention mutations.

mod index;
mod index_io;
mod manifest;
mod operator;
mod paths;
mod retention;

#[cfg(test)]
#[path = "box_store/tests.rs"]
mod tests;

use std::{path::PathBuf, sync::Arc};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

use super::mutable_paths;

pub(crate) use index::BoxIndexReport;
pub(crate) use retention::BoxRetentionReport;

pub(crate) struct BoxStoreService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl BoxStoreService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
        }
    }

    pub(crate) async fn rebuild_index(&self) -> CognitionResult<BoxIndexReport> {
        self.with_lease("box_index", |root| index::rebuild_index(&root))
            .await
    }

    pub(crate) async fn retention(&self, now_epoch_ms: i64) -> CognitionResult<BoxRetentionReport> {
        self.with_lease("box_retention", move |root| {
            retention::prune_expired(&root, now_epoch_ms)
        })
        .await
    }

    pub(crate) async fn count_indexed(&self) -> CognitionResult<usize> {
        self.with_lease("box_index_read", |root| index::count_indexed(&root))
            .await
    }

    pub(crate) async fn manifest_exists(&self, id: &str) -> CognitionResult<bool> {
        let id = id.to_owned();
        self.with_lease("box_manifest_read", move |root| {
            manifest::manifest_exists(&root, &id)
        })
        .await
    }

    async fn with_lease<T, F>(&self, purpose: &'static str, operation: F) -> CognitionResult<T>
    where
        T: Send + 'static,
        F: FnOnce(PathBuf) -> CognitionResult<T> + Send + 'static,
    {
        let cognition_root = self.paths.cognition_root(&self.data_root);
        let root = cognition_root.join("box");
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        mutable_paths::ensure_data_authority(
            &self.data_root,
            &[&cognition_root, &root, &lock_path],
        )
        .map_err(|_| error("memory_box_root_path_unsafe"))?;
        let coordinator = self.coordinator.clone();
        let lease = coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock_path, purpose),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|error| CognitionError::new(error.code, error.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        tokio::task::spawn_blocking(move || {
            let result = operation(root);
            let released = lease
                .release(result.is_ok())
                .map_err(|error| CognitionError::new(error.code, error.message));
            match (result, released) {
                (Err(error), _) => Err(error),
                (Ok(_), Err(error)) => Err(error),
                (Ok(value), Ok(())) => Ok(value),
            }
        })
        .await
        .map_err(|_| error("memory_box_store_io_failed"))?
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, "Cognition Box operation failed")
}
