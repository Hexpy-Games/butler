//! Source-compatible durable inbound queue for the standalone native owner.

mod record;
mod storage;
#[cfg(test)]
mod tests;

pub(crate) use record::{ClaimedInboundEvent, QueuedInboundEvent};

use parking_lot::Mutex;
use std::{collections::HashSet, fmt, path::PathBuf, sync::Arc};

use serde_json::{Map, Value};
use tokio::sync::Notify;

use crate::json::JsonDocument;

#[derive(Clone, Debug)]
pub(crate) struct NativeInboundQueue {
    root: PathBuf,
    owner_id: String,
    lane: Arc<Mutex<()>>,
    enqueue_wake: Arc<Notify>,
}

#[derive(Clone, Debug)]
pub(crate) struct NativeQueueError {
    pub code: &'static str,
    pub message: String,
}

impl NativeQueueError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for NativeQueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NativeQueueError {}

pub(crate) type QueueResult<T> = Result<T, NativeQueueError>;

impl NativeInboundQueue {
    pub(crate) fn new(butler_data: PathBuf) -> Self {
        Self {
            root: butler_data.join("runtime/inbound-events"),
            owner_id: format!("{}:{}", std::process::id(), uuid::Uuid::new_v4()),
            lane: Arc::new(Mutex::new(())),
            enqueue_wake: Arc::new(Notify::new()),
        }
    }

    pub(crate) async fn wait_for_enqueue(&self) {
        self.enqueue_wake.notified().await;
    }

    pub(crate) fn enqueue_idempotent(
        &self,
        envelope: JsonDocument,
    ) -> QueueResult<QueuedInboundEvent> {
        self.enqueue_idempotent_with_metadata(envelope, Map::new())
    }

    pub(crate) fn enqueue_idempotent_with_metadata(
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

    pub(crate) fn find_idempotent(
        &self,
        envelope: &JsonDocument,
    ) -> QueueResult<Option<QueuedInboundEvent>> {
        let _guard = self.lane.lock();
        storage::find_idempotent(&self.root, envelope)
    }

    pub(crate) fn claim_eligible(
        &self,
        limit: usize,
        eligible: impl FnMut(&QueuedInboundEvent) -> bool,
    ) -> QueueResult<Vec<ClaimedInboundEvent>> {
        let _guard = self.lane.lock();
        storage::claim(&self.root, &self.owner_id, limit, eligible)
    }

    pub(crate) fn complete(
        &self,
        item: &ClaimedInboundEvent,
        metadata: Value,
    ) -> QueueResult<bool> {
        let _guard = self.lane.lock();
        storage::settle(&self.root, item, "processed", None, metadata)
    }

    pub(crate) fn park_for_process_replacement(
        &self,
        item: &ClaimedInboundEvent,
        error: &str,
    ) -> QueueResult<bool> {
        let _guard = self.lane.lock();
        storage::park(&self.root, item, error)
    }

    pub(crate) fn recover_runtime_interruptions(&self) -> QueueResult<usize> {
        let _guard = self.lane.lock();
        storage::recover_runtime_interruptions(&self.root)
    }

    pub(crate) fn recover_stale_processing_except(
        &self,
        active: &HashSet<String>,
    ) -> QueueResult<usize> {
        let _guard = self.lane.lock();
        storage::recover_stale(&self.root, &self.owner_id, active)
    }
}
