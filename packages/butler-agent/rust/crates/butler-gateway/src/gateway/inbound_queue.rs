//! Source-compatible durable inbound queue for the standalone native owner.

mod error;
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
    lane: Arc<Mutex<Lane>>,
    enqueue_wake: Arc<Notify>,
    settlements: Arc<observers::Observers>,
}

pub(crate) type QueueResult<T> = Result<T, InboundQueueError>;

impl InboundQueue {
    async fn blocking<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Self) -> QueueResult<T> + Send + 'static,
    ) -> QueueResult<T> {
        let timing = super::command_timing::CommandTiming::new("inbound_blocking");
        let queue = self.clone();
        tokio::task::spawn_blocking(move || {
            timing.mark("dequeued");
            operation(queue)
        })
        .await
        .map_err(|error| {
            InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
        })?
    }

    pub async fn enqueue_async(&self, envelope: JsonDocument) -> QueueResult<QueuedInboundEvent> {
        self.blocking(move |queue| queue.enqueue_idempotent(envelope))
            .await
    }

    /// Publish work already committed by a durable owner which reconstructs
    /// missing queue entries on restart. Claiming still syncs the execution
    /// lease before dispatch. Ordinary message acceptance must use enqueue_async.
    pub async fn enqueue_reconstructible_async(
        &self,
        envelope: JsonDocument,
    ) -> QueueResult<QueuedInboundEvent> {
        self.blocking(move |queue| queue.publish(envelope, Map::new(), false))
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
            lane: Arc::default(),
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
        self.publish(envelope, metadata, true)
    }

    /// Stages the record without the lane; under it only the identity check
    /// and the rename run. The caller is answered after the directory sync.
    fn publish(
        &self,
        envelope: JsonDocument,
        metadata: Map<String, Value>,
        durable: bool,
    ) -> QueueResult<QueuedInboundEvent> {
        let timing = super::command_timing::CommandTiming::new("inbound_enqueue");
        let record = match storage::prepare_enqueue(&self.root, envelope, metadata, durable)? {
            storage::Prepared::Found(record) => *record,
            storage::Prepared::Staged(staged) => {
                timing.mark("record_staged");
                let enqueued = {
                    let _lane = self.lane.lock();
                    timing.mark("lock_acquired");
                    storage::commit_enqueue(&self.root, staged)?
                };
                timing.mark("record_renamed");
                enqueued.finish()?
            }
        };
        timing.mark("record_published");
        // Either this write or its reconstructing owner is already durable.
        self.enqueue_wake.notify_one();
        Ok(record)
    }

    pub fn find_idempotent(
        &self,
        envelope: &JsonDocument,
    ) -> QueueResult<Option<QueuedInboundEvent>> {
        let _lane = self.lane.lock();
        storage::find_idempotent(&self.root, envelope)
    }

    /// Leases are staged and synced without the lane; under it only the
    /// renames that claim unchanged pending records run.
    pub fn claim_eligible(
        &self,
        limit: usize,
        eligible: impl FnMut(&QueuedInboundEvent) -> bool,
    ) -> QueueResult<Vec<ClaimedInboundEvent>> {
        let candidates = storage::select_claims(&self.root, &self.owner_id, limit, eligible)?;
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let timing = super::command_timing::CommandTiming::new("inbound_claim");
        let claimed = {
            let _lane = self.lane.lock();
            timing.mark("lock_acquired");
            storage::take_claims(candidates)?
        };
        timing.mark("claims_renamed");
        let items = claimed.finish()?;
        timing.mark("claims_published");
        Ok(items)
    }

    pub fn complete(&self, item: &ClaimedInboundEvent, metadata: Value) -> QueueResult<bool> {
        let settlement = storage::settle(&self.root, item, "processed", None, metadata);
        let accepted = self.settle_claim(item, settlement)?;
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
        let settlement = storage::settle(&self.root, item, "failed", Some(error), metadata);
        let accepted = self.settle_claim(item, settlement)?;
        self.settlements.settled(accepted);
        Ok(accepted)
    }

    /// Returns a claimed record to pending, metadata kept, for another attempt
    /// after a backoff (1 s, doubling per deferral, at most 60 s).
    pub fn defer(&self, item: &ClaimedInboundEvent, error: &str) -> QueueResult<bool> {
        self.settle_claim(item, storage::defer(&self.root, item, error))
    }

    pub fn park_for_process_replacement(
        &self,
        item: &ClaimedInboundEvent,
        error: &str,
    ) -> QueueResult<bool> {
        self.settle_claim(item, storage::park(&self.root, item, error))
    }

    /// Publishes a staged settlement while `item` owns its claim, syncs it
    /// without the lane, then releases the claimed copy. A claim being
    /// settled is not settled again meanwhile.
    fn settle_claim(
        &self,
        item: &ClaimedInboundEvent,
        settlement: QueueResult<storage::Settlement>,
    ) -> QueueResult<bool> {
        let settlement = settlement?;
        let claim = &item.processing.claim_id;
        let published = {
            let mut lane = self.lane.lock();
            if lane.settling.contains(claim) {
                None
            } else {
                let published = storage::publish_settlement(item, settlement)?;
                if published.is_some() {
                    lane.settling.insert(claim.clone());
                }
                published
            }
        };
        let Some(published) = published else {
            return Ok(false);
        };
        let synced = published.committed.sync();
        let mut lane = self.lane.lock();
        let released = synced.and_then(|()| storage::release_claim(item, published.release));
        lane.settling.remove(claim);
        released.map(|()| true)
    }

    pub fn recover_runtime_interruptions(&self) -> QueueResult<usize> {
        let _lane = self.lane.lock();
        storage::recover_runtime_interruptions(&self.root)
    }

    pub fn recover_stale_processing_except(&self, active: &HashSet<String>) -> QueueResult<usize> {
        let _lane = self.lane.lock();
        storage::recover_stale(&self.root, &self.owner_id, active)
    }
}

/// State the queue lane orders: claims whose settlement is published but not
/// yet released.
#[derive(Debug, Default)]
struct Lane {
    settling: HashSet<String>,
}
