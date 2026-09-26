//! Source-compatible Cognition namespace migration plan and marker owner.

mod plan;

use std::{path::PathBuf, sync::Arc};

use serde::Serialize;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

const SCHEMA: &str = "butler.cognition.namespace-migration.v1";

#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the serialized result schema field for field"
)]
#[derive(Clone, Debug, Serialize)]
pub(crate) struct CognitionNamespaceMigrationPlan {
    pub schema: &'static str,
    pub status: String,
    pub legacy_memory_root: String,
    pub cognition_root: String,
    pub cognition_memory_root: String,
    pub migration_root: String,
    pub manifest_path: String,
    pub legacy_exists: bool,
    pub cognition_memory_exists: bool,
    pub legacy_file_count: usize,
    pub legacy_byte_count: u64,
    pub cognition_memory_file_count: usize,
    pub cognition_memory_byte_count: u64,
    pub conflicts: Vec<String>,
    #[serde(rename = "rawTextIncluded")]
    pub raw_text_included: bool,
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct CognitionNamespaceMigrationManifest {
    pub schema: &'static str,
    pub migration_id: String,
    pub started_at: String,
    pub completed_at: String,
    pub legacy_memory_root: String,
    pub cognition_root: String,
    pub cognition_memory_root: String,
    pub backup_root: Option<String>,
    pub moved_paths: Vec<MigrationMove>,
    pub conflicts: Vec<String>,
    pub status: String,
    #[serde(rename = "rawTextIncluded")]
    pub raw_text_included: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct MigrationMove {
    pub from: String,
    pub to: String,
}

pub(crate) struct CognitionNamespaceMigrationService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

#[derive(Clone, Copy, Default)]
struct FileStats {
    files: usize,
    bytes: u64,
}

impl CognitionNamespaceMigrationService {
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

    pub(crate) async fn plan(&self) -> CognitionResult<CognitionNamespaceMigrationPlan> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || plan::build_plan(&data_root, &paths))
            .await
            .map_err(|_| failure("cognition_migration_read_failed"))?
    }

    pub(crate) async fn apply(&self) -> CognitionResult<CognitionNamespaceMigrationManifest> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(
                    self.paths.consolidation_lock(&self.data_root),
                    "cognition_namespace_migration",
                ),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|error| CognitionError::new(error.code, error.message))?
            .ok_or_else(|| failure("memory_write_busy"))?;
        tokio::task::spawn_blocking(move || {
            let result = plan::apply_locked(&data_root, &paths);
            let released = lease
                .release(result.is_ok())
                .map_err(|error| CognitionError::new(error.code, error.message));
            match (result, released) {
                (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                (Ok(value), Ok(())) => Ok(value),
            }
        })
        .await
        .map_err(|_| failure("cognition_migration_apply_failed"))?
    }
}

fn failure(code: &'static str) -> CognitionError {
    CognitionError::new(code, "Cognition namespace migration failed")
}
