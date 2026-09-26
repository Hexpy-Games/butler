//! Short leased v2 edge consolidation in the active generation.

use std::{path::PathBuf, sync::Arc};

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, graph::GraphRepository,
    mutable_paths, resolve_active_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};

pub(crate) struct GraphConsolidationService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl GraphConsolidationService {
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

    pub(crate) async fn run(
        &self,
        expected_generation: &str,
        now_ms: i64,
        decay_d: f64,
    ) -> CognitionResult<serde_json::Value> {
        let cognition_root = self.paths.cognition_root(&self.data_root);
        let memory_root = self.paths.memory_root(&self.data_root);
        let lock = self.paths.consolidation_lock(&self.data_root);
        mutable_paths::ensure_data_authority(
            &self.data_root,
            &[&cognition_root, &memory_root, &lock],
        )?;
        let handle = resolve_active_generation(&self.data_root, &self.paths)?;
        if handle.generation_id != expected_generation {
            return Err(error("memory_generation_changed"));
        }
        mutable_paths::ensure_data_authority(&self.data_root, &[&handle.root, &handle.graph_path])?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock, "consolidate"),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|error| CognitionError::new(error.code, error.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let expected = expected_generation.to_owned();
        tokio::task::spawn_blocking(move || {
            let result = (|| {
                let current = resolve_active_generation(&data_root, &paths)?;
                if current.generation_id != expected { return Err(error("memory_generation_changed")); }
                let mut graph = GraphRepository::open(&current.graph_path)?;
                let metrics = graph.consolidate(now_ms, decay_d)?;
                graph.close()?;
                Ok(serde_json::json!({"candidates_considered":metrics.candidates_considered,"merges_applied":metrics.merges_applied,"edges_boosted":metrics.edges_boosted,"conflicts_archived":metrics.conflicts_archived,"activations_written":metrics.activations_written}))
            })();
            let released = lease.release(result.is_ok()).map_err(|error| CognitionError::new(error.code,error.message));
            match (result,released) { (Err(error),_) | (Ok(_),Err(error)) => Err(error), (Ok(value),Ok(())) => Ok(value) }
        }).await.map_err(|_| error("memory_consolidation_operation_failed"))?
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
