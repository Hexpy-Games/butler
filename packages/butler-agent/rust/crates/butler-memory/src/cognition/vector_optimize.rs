//! Native Lance maintenance for the selected active memory generation.
//! Connections, tables, and their bounded caches live only for one run.

use crate::cognition::CognitionCode;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use lancedb::Table;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
    MemoryGenerationTarget, assert_mutation_authority, graph::GraphRepository, lance_maintenance,
    lance_store, mutable_paths, resolve_active_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};

const DELETE_BATCH: usize = 100;

/// What a vector optimize run did.
#[derive(Debug, PartialEq, Eq)]
pub enum VectorOptimizeOutcome {
    /// The vector store could not be opened.
    Unavailable {
        /// Why.
        reason: &'static str,
        /// Vectors pruned before the store became unavailable.
        vectors_pruned: usize,
    },
    /// The run finished.
    Metrics {
        /// Caches compacted (always 0; kept for the legacy report).
        caches_compacted: usize,
        /// Summaries re-embedded (always 0; kept for the legacy report).
        summaries_re_embedded: usize,
        /// Vectors of removed units deleted.
        vectors_pruned: usize,
        /// Whether the table files were compacted.
        lancedb_compacted: bool,
    },
}

/// Prunes vectors of removed units from the active generation and compacts the table.
pub struct VectorOptimizeService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    store: LanceStore,
}

impl VectorOptimizeService {
    /// An optimize service over `data_root`.
    pub fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
            store: LanceStore::new(),
        }
    }

    /// Runs one optimize pass within the deadline.
    pub async fn run(
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
            () = cancellation.cancelled() => return Err(error(CognitionCode::MemoryWriteAborted)),
            () = tokio::time::sleep(remaining(deadline_at_epoch_ms)?) =>
                return Err(error(CognitionCode::MemoryWriteBusy)),
            permit = self.store.one_at_a_time.acquire() =>
                permit.map_err(|source| error(CognitionCode::VectorStoreUnavailable).with_source(source))?,
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
            .acquire(lock_path, cancellation, deadline_at_epoch_ms)
            .await?;
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
        let vectors_pruned = prune(&table, &ordered, cancellation, deadline_at_epoch_ms).await?;
        // Maintenance is best effort: a failure leaves the table as it was.
        // Old versions beyond the newest few are pruned, so a rollback reaches
        // back a bounded number of writes, not to the table's creation.
        let lancedb_compacted = if check_entry(cancellation, deadline_at_epoch_ms).is_err() {
            false
        } else {
            match lance_maintenance::maintain(&table).await {
                Ok(maintained) => maintained.compacted,
                Err(_) => {
                    lance_store::forget(&generation.root.join("butler.lance"), "butler_memory");
                    false
                }
            }
        };
        lease
            .release(true)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        Ok(VectorOptimizeOutcome::Metrics {
            caches_compacted: 0,
            summaries_re_embedded: 0,
            vectors_pruned,
            lancedb_compacted,
        })
    }
}

impl VectorOptimizeService {
    /// The consolidation lease for the optimize run.
    async fn acquire(
        &self,
        lock_path: PathBuf,
        cancellation: &CancellationToken,
        deadline_at_epoch_ms: i64,
    ) -> CognitionResult<crate::coordination::CognitionWriteLease> {
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
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
            .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
        lease
            .assert_for_path(&lock_path)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        Ok(lease)
    }
}

/// Deletes the vectors in batches; the number of rows deleted.
async fn prune(
    table: &Table,
    ordered: &[String],
    cancellation: &CancellationToken,
    deadline_at_epoch_ms: i64,
) -> CognitionResult<usize> {
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
            .map_err(|source| error(CognitionCode::VectorStoreUnavailable).with_source(source))?;
        vectors_pruned += usize::try_from(deleted.num_deleted_rows)
            .map_err(|source| error(CognitionCode::VectorStoreUnavailable).with_source(source))?;
    }
    Ok(vectors_pruned)
}

struct LanceStore {
    one_at_a_time: Semaphore,
}

impl LanceStore {
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
        match lance_store::shared(&uri, "butler_memory").await {
            Ok(table) => Ok(Some(table)),
            Err(_) => Ok(None),
        }
    }
}

async fn read_removable_keys(path: PathBuf) -> CognitionResult<Vec<String>> {
    tokio::task::spawn_blocking(move || GraphRepository::open(&path)?.removable_vector_keys())
        .await
        .map_err(|source| error(CognitionCode::MemoryGraphUnavailable).with_source(source))?
}

fn remaining(deadline_at_epoch_ms: i64) -> CognitionResult<Duration> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
        .as_millis();
    let millis = i128::from(deadline_at_epoch_ms) - i128::try_from(now).unwrap_or(i128::MAX);
    if millis <= 0 {
        return Err(error(CognitionCode::MemoryWriteBusy));
    }
    Ok(Duration::from_millis(
        u64::try_from(millis).unwrap_or(u64::MAX),
    ))
}

fn check_entry(cancellation: &CancellationToken, deadline_at_epoch_ms: i64) -> CognitionResult<()> {
    if cancellation.is_cancelled() {
        Err(error(CognitionCode::MemoryWriteAborted))
    } else {
        remaining(deadline_at_epoch_ms).map(|_| ())
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
