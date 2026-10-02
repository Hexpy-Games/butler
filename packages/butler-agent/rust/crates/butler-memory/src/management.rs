//! Request-driven memory inventory and conservative dormant-storage cleanup.
//!
//! No constructor, page read or idle task opens a database or enumerates files.
//! Measurements are explicit, cancellable adoption work. Leased mutations invalidate
//! the in-memory summary; after restart all measurements require an explicit check.
mod cleanup;
mod inventory;
pub use cleanup::{CleanupItem, CleanupResult};
mod measurement;
mod project;
mod reset;
mod safety;
pub use crate::cognition::ResetResult;

use crate::{
    cognition::{CognitionPathEnvironment, MemoryHealthService},
    coordination::CognitionWriteCoordinator,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io, path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

/// One Memory card. Unknown measurements serialize as null rather than zero.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoryCard {
    /// Stable UI kind.
    pub kind: String,
    /// Unit used for count.
    pub count_unit: String,
    /// Active items, when an authoritative count exists.
    pub item_count: Option<u64>,
    /// Pending profile candidates, for the Profile card.
    pub pending_count: Option<u64>,
    /// Physical allocation, including archives; shared search storage is Automatic only.
    pub allocated_bytes: Option<u64>,
    /// Last learned-content change, not the measurement or cleanup time.
    pub content_updated_at: Option<String>,
    /// Health details; automatic health reuses the existing health result.
    pub health: Value,
}

/// An inventory snapshot, with explicit freshness and measurement time.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoryInventory {
    /// `not_measured` or `measured`; never claims stale measurements are current.
    pub state: String,
    /// Process-local writer epoch this measurement covers.
    pub revision: u64,
    /// When explicit measurement completed.
    pub measured_at: Option<String>,
    /// Exactly four cards in UI order.
    pub kinds: Vec<MemoryCard>,
    /// Physical allocation of unresolved dead letters; cleanup never deletes them.
    pub dead_letter_allocated_bytes: Option<u64>,
}

/// Process-owned backend. Construction performs no I/O and creates no worker.
pub struct MemoryManagement {
    root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    cache: Mutex<Option<MemoryInventory>>,
}

impl MemoryManagement {
    /// Binds the existing memory coordinator; caller remains the sole data-folder owner.
    pub fn new(
        root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            root,
            paths,
            coordinator,
            cache: Mutex::new(None),
        }
    }

    /// O(four cards), two atomic revision reads, zero filesystem/database I/O.
    pub fn inventory(&self) -> MemoryInventory {
        let revision = self.coordinator.inventory_revision();
        self.cache
            .lock()
            .as_ref()
            .filter(|s| s.revision == revision)
            .cloned()
            .unwrap_or_else(|| inventory::unknown(revision))
    }

    /// Persists acceptance before the App returns an operation ID; no scan or deletion.
    pub async fn begin_cleanup(&self, id: String, revision: u64) -> io::Result<CleanupResult> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            cleanup::begin(&root, &paths, &coordinator, &id, revision)
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Reads one durable receipt on a blocking worker, for initial view/reconnect.
    pub async fn cleanup_status(&self, id: String) -> io::Result<Option<CleanupResult>> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || {
            safety::validate(&root, &paths)?;
            cleanup::receipt(&paths.memory_root(&root), &id)
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Explicit cleanup. Cancellation leaves durable trash for the next explicit request.
    pub async fn cleanup(
        &self,
        id: String,
        revision: u64,
        cancellation: CancellationToken,
        publish: Arc<dyn Fn(CleanupResult) + Send + Sync>,
    ) -> io::Result<CleanupResult> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            cleanup::run(
                (&root, &paths, &coordinator),
                &id,
                revision,
                &cancellation,
                publish.as_ref(),
            )
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Explicit adoption/check; filesystem and SQL work run on blocking workers.
    pub async fn refresh(
        &self,
        now: String,
        cancellation: CancellationToken,
    ) -> io::Result<MemoryInventory> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        let lease = tokio::task::spawn_blocking(move || {
            safety::validate(&root, &paths)?;
            coordinator
                .try_acquire(&crate::coordination::CognitionWriteAcquire::immediate(
                    paths.consolidation_lock(&root),
                    "memory_inventory",
                ))
                .map_err(io::Error::other)?
                .ok_or_else(|| io::Error::other("Memory is in use"))
        })
        .await
        .map_err(io::Error::other)??;
        let epoch = self.coordinator.inventory_revision();
        let health = MemoryHealthService::new(
            self.root.clone(),
            self.paths.clone(),
            self.coordinator.clone(),
        )
        .read()
        .await
        .map_err(io::Error::other)
        .and_then(|report| report.summary().map_err(io::Error::other));
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        let value = tokio::task::spawn_blocking(move || {
            let measured = health.and_then(|health| {
                inventory::measure(&root, &paths, epoch, now, &health, &cancellation)
            });
            let unchanged = coordinator.inventory_revision() == epoch;
            let released = lease.release(false).map_err(io::Error::other);
            released?;
            if !unchanged {
                return Err(io::Error::other("Memory changed; check again"));
            }
            measured
        })
        .await
        .map_err(io::Error::other)??;
        let mut value = value;
        value.revision = epoch.saturating_add(1);
        if self.coordinator.inventory_revision() != value.revision {
            return Err(io::Error::other("Memory changed; check again"));
        }
        *self.cache.lock() = Some(value.clone());
        Ok(value)
    }
}
