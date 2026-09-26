//! Native Lance maintenance for the selected active memory generation.
//! Connections, tables, and their bounded caches live only for one run.

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use lancedb::{Table, table::OptimizeAction};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
    MemoryGenerationTarget, assert_mutation_authority, graph::GraphRepository, lance_store,
    mutable_paths, resolve_active_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};

const DELETE_BATCH: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum VectorOptimizeOutcome {
    Unavailable {
        reason: &'static str,
        vectors_pruned: usize,
    },
    Metrics {
        caches_compacted: usize,
        summaries_re_embedded: usize,
        vectors_pruned: usize,
        lancedb_compacted: bool,
    },
}

pub(crate) struct NativeVectorOptimizeService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    store: NativeLanceStore,
}

impl NativeVectorOptimizeService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
            store: NativeLanceStore::new(),
        }
    }

    pub(crate) async fn run(
        &self,
        cancellation: &CancellationToken,
        deadline_at_epoch_ms: i64,
    ) -> CognitionResult<VectorOptimizeOutcome> {
        check_entry(cancellation, deadline_at_epoch_ms)?;
        let generation = resolve_active_generation(&self.data_root, &self.paths)?;
        let cognition_root = self.paths.cognition_root(&self.data_root);
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        let lance_root = generation.root.join("butler.lance");
        mutable_paths::ensure_data_authority(
            &self.data_root,
            &[&cognition_root, &generation.root, &lance_root, &lock_path],
        )?;
        // Legacy CLI opens the table first and reports unavailable if absent.
        // No connection or model is loaded until optimize is actually requested.
        let _operation = tokio::select! {
            _ = cancellation.cancelled() => return Err(error("memory_write_aborted")),
            _ = tokio::time::sleep(remaining(deadline_at_epoch_ms)?) =>
                return Err(error("memory_write_busy")),
            permit = self.store.one_at_a_time.acquire() =>
                permit.map_err(|_| error("vector_store_unavailable"))?,
        };
        check_entry(cancellation, deadline_at_epoch_ms)?;
        let Some(table) = self.store.open(&generation).await? else {
            return Ok(VectorOptimizeOutcome::Unavailable {
                reason: "vector_store_unavailable",
                vectors_pruned: 0,
            });
        };
        check_entry(cancellation, deadline_at_epoch_ms)?;
        let candidates: HashSet<_> = read_removable_keys(generation.graph_path.clone())
            .await?
            .into_iter()
            .collect();
        check_entry(cancellation, deadline_at_epoch_ms)?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire {
                    lock_path: lock_path.clone(),
                    purpose: Some("memory-vector-optimize".into()),
                    deadline_at_epoch_ms: Some(deadline_at_epoch_ms as f64),
                    cancellation: Some(cancellation.clone()),
                },
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|_| error("memory_write_busy"))?
            .ok_or_else(|| error("memory_write_busy"))?;
        lease
            .assert_for_path(&lock_path)
            .map_err(|_| error("memory_write_busy"))?;
        let target = MemoryGenerationTarget::Active {
            expected_generation: generation.generation_id.clone(),
        };
        assert_mutation_authority(&self.data_root, &self.paths, &target, &generation)?;
        check_entry(cancellation, deadline_at_epoch_ms)?;
        let mut ordered: Vec<_> = read_removable_keys(generation.graph_path.clone())
            .await?
            .into_iter()
            .filter(|key| candidates.contains(key))
            .collect();
        ordered.sort();
        let mut vectors_pruned = 0;
        for batch in ordered.chunks(DELETE_BATCH) {
            check_entry(cancellation, deadline_at_epoch_ms)?;
            let predicate = format!(
                "vector_key IN ({})",
                batch
                    .iter()
                    .map(|key| format!("'{}'", key.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let deleted = table
                .delete(&predicate)
                .await
                .map_err(|_| error("vector_store_unavailable"))?;
            vectors_pruned += usize::try_from(deleted.num_deleted_rows)
                .map_err(|_| error("vector_store_unavailable"))?;
        }
        // A compaction failure is optional in the legacy path. Compact files
        // only: pruning old Lance versions would erase retained rollback data.
        let lancedb_compacted =
            if ordered.is_empty() || check_entry(cancellation, deadline_at_epoch_ms).is_err() {
                false
            } else {
                table
                    .optimize(OptimizeAction::Compact {
                        options: Default::default(),
                        remap_options: None,
                    })
                    .await
                    .is_ok()
            };
        lease
            .release(true)
            .map_err(|_| error("memory_write_busy"))?;
        Ok(VectorOptimizeOutcome::Metrics {
            caches_compacted: 0,
            summaries_re_embedded: 0,
            vectors_pruned,
            lancedb_compacted,
        })
    }
}

struct NativeLanceStore {
    one_at_a_time: Semaphore,
}

impl NativeLanceStore {
    fn new() -> Self {
        Self {
            one_at_a_time: Semaphore::new(1),
        }
    }

    async fn open(&self, generation: &MemoryGenerationHandle) -> CognitionResult<Option<Table>> {
        let uri = generation.root.join("butler.lance");
        if !uri.exists() {
            return Ok(None);
        }
        let connection = lance_store::connect(&uri)
            .await
            .map_err(|_| error("vector_store_unavailable"))?;
        match lance_store::open(&connection, "butler_memory").await {
            Ok(table) => Ok(Some(table)),
            Err(_) => Ok(None),
        }
    }
}

async fn read_removable_keys(path: PathBuf) -> CognitionResult<Vec<String>> {
    tokio::task::spawn_blocking(move || GraphRepository::open(&path)?.removable_vector_keys())
        .await
        .map_err(|_| error("memory_graph_unavailable"))?
}

fn remaining(deadline_at_epoch_ms: i64) -> CognitionResult<Duration> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error("memory_write_busy"))?
        .as_millis();
    let millis = (deadline_at_epoch_ms as i128) - (now as i128);
    if millis <= 0 {
        return Err(error("memory_write_busy"));
    }
    Ok(Duration::from_millis(millis.min(u64::MAX as i128) as u64))
}

fn check_entry(cancellation: &CancellationToken, deadline_at_epoch_ms: i64) -> CognitionResult<()> {
    if cancellation.is_cancelled() {
        Err(error("memory_write_aborted"))
    } else {
        remaining(deadline_at_epoch_ms).map(|_| ())
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
