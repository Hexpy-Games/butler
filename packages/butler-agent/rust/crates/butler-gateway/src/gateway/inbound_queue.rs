//! Source-compatible durable inbound queue for the standalone native owner.

mod error;
#[cfg(debug_assertions)]
mod fixture;
mod observers;
mod record;
mod storage;
#[cfg(test)]
mod tests;

pub use error::{InboundQueueCode, InboundQueueError};
pub use observers::InboundSettlementListener;
pub use record::{ClaimedInboundEvent, QueuedInboundEvent};

use parking_lot::Mutex;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Map, Value};
use tokio::sync::Notify;

use butler_core::json::JsonDocument;

#[derive(Clone, Debug)]
pub struct InboundQueue {
    root: PathBuf,
    owner_id: String,
    lane: Arc<Mutex<()>>,
    enqueue_wake: Arc<Notify>,
    settlements: Arc<observers::Observers>,
}

pub(crate) type QueueResult<T> = Result<T, InboundQueueError>;

impl InboundQueue {
    async fn blocking<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Self) -> QueueResult<T> + Send + 'static,
    ) -> QueueResult<T> {
        let queue = self.clone();
        tokio::task::spawn_blocking(move || operation(queue))
            .await
            .map_err(|error| {
                InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
            })?
    }

    pub async fn enqueue_async(&self, envelope: JsonDocument) -> QueueResult<QueuedInboundEvent> {
        self.blocking(move |queue| queue.enqueue_idempotent(envelope))
            .await
    }

    pub async fn find_async(
        &self,
        envelope: JsonDocument,
    ) -> QueueResult<Option<QueuedInboundEvent>> {
        self.blocking(move |queue| queue.find_idempotent(&envelope))
            .await
    }

    pub async fn complete_async(
        &self,
        item: ClaimedInboundEvent,
        metadata: Value,
    ) -> QueueResult<bool> {
        #[cfg(debug_assertions)]
        fixture::before_settlement(&self.root).await?;
        self.blocking(move |queue| queue.complete(&item, metadata))
            .await
    }

    pub async fn fail_async(
        &self,
        item: ClaimedInboundEvent,
        error: String,
        metadata: Value,
    ) -> QueueResult<bool> {
        self.blocking(move |queue| queue.fail(&item, &error, metadata))
            .await
    }

    pub async fn defer_async(&self, item: ClaimedInboundEvent, error: String) -> QueueResult<bool> {
        self.blocking(move |queue| queue.defer(&item, &error)).await
    }

    pub async fn park_async(&self, item: ClaimedInboundEvent, error: String) -> QueueResult<bool> {
        self.blocking(move |queue| queue.park_for_process_replacement(&item, &error))
            .await
    }

    pub fn new(butler_data: &Path) -> Self {
        Self {
            root: butler_data.join("runtime/inbound-events"),
            owner_id: format!("{}:{}", std::process::id(), uuid::Uuid::new_v4()),
            lane: Arc::new(Mutex::new(())),
            enqueue_wake: Arc::new(Notify::new()),
            settlements: Arc::default(),
        }
    }

    /// Wait exactly for the next durable deferral deadline, if one exists.
    pub async fn next_deferred_delay(&self) -> QueueResult<Option<std::time::Duration>> {
        self.blocking(move |queue| storage::next_delay(&queue.root))
            .await
    }

    /// Observe external queue writes and service control files before recovery.
    pub async fn observe_changes(
        &self,
        signals: Vec<PathBuf>,
    ) -> QueueResult<super::FileChangeWatch> {
        super::FileChangeWatch::observe(self.root.clone(), signals)
            .await
            .map_err(|error| {
                InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
            })
    }

    pub async fn wait_for_enqueue(&self) {
        self.enqueue_wake.notified().await;
    }

    pub fn observe_settlements(&self, listener: InboundSettlementListener) {
        self.settlements.add(listener);
    }

    pub fn enqueue_idempotent(&self, envelope: JsonDocument) -> QueueResult<QueuedInboundEvent> {
        self.enqueue_idempotent_with_metadata(envelope, Map::new())
    }

    pub fn enqueue_idempotent_with_metadata(
        &self,
        envelope: JsonDocument,
        metadata: Map<String, Value>,
    ) -> QueueResult<QueuedInboundEvent> {
        let _guard = self.lane.lock();
        let result = storage::enqueue_idempotent(&self.root, envelope, metadata);
        if result.is_ok() {
            // The durable queue write precedes this coalesced in-process wake.
            self.enqueue_wake.notify_one();
        }
        result
    }

    pub fn find_idempotent(
        &self,
        envelope: &JsonDocument,
    ) -> QueueResult<Option<QueuedInboundEvent>> {
        let _guard = self.lane.lock();
        storage::find_idempotent(&self.root, envelope)
    }

    pub fn claim_eligible(
        &self,
        limit: usize,
        eligible: impl FnMut(&QueuedInboundEvent) -> bool,
    ) -> QueueResult<Vec<ClaimedInboundEvent>> {
        let _guard = self.lane.lock();
        storage::claim(&self.root, &self.owner_id, limit, eligible)
    }

    pub fn complete(&self, item: &ClaimedInboundEvent, metadata: Value) -> QueueResult<bool> {
        let _guard = self.lane.lock();
        let accepted = storage::settle(&self.root, item, "processed", None, metadata)?;
        self.settlements.settled(accepted);
        Ok(accepted)
    }

    /// Settles a claimed record as failed with `error`; it is not retried.
    pub fn fail(
        &self,
        item: &ClaimedInboundEvent,
        error: &str,
        metadata: Value,
    ) -> QueueResult<bool> {
        let _guard = self.lane.lock();
        let accepted = storage::settle(&self.root, item, "failed", Some(error), metadata)?;
        self.settlements.settled(accepted);
        Ok(accepted)
    }

    /// Returns a claimed record to pending, metadata kept, for another attempt
    /// after a backoff (1 s, doubling per deferral, at most 60 s).
    pub fn defer(&self, item: &ClaimedInboundEvent, error: &str) -> QueueResult<bool> {
        let _guard = self.lane.lock();
        storage::defer(&self.root, item, error)
    }

    pub fn park_for_process_replacement(
        &self,
        item: &ClaimedInboundEvent,
        error: &str,
    ) -> QueueResult<bool> {
        let _guard = self.lane.lock();
        storage::park(&self.root, item, error)
    }

    pub fn recover_runtime_interruptions(&self) -> QueueResult<usize> {
        let _guard = self.lane.lock();
        storage::recover_runtime_interruptions(&self.root)
    }

    pub fn recover_stale_processing_except(&self, active: &HashSet<String>) -> QueueResult<usize> {
        let _guard = self.lane.lock();
        storage::recover_stale(&self.root, &self.owner_id, active)
    }
}
