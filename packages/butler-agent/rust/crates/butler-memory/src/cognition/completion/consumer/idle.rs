//! Only unfinished durable work needs a timer; native changes wake an empty consumer.
use super::super::wake;
use super::{MemorySyncConsumer, blocking};
use crate::cognition::{CognitionResult, generation::resolve_active_generation};
use std::{sync::atomic::Ordering, time::Duration};

impl MemorySyncConsumer {
    /// Preserve recovery and deferred-job backoff, otherwise park until a source changes.
    pub async fn idle_delay(&self, backoff: Duration) -> CognitionResult<Option<Duration>> {
        let data = self.data_root.clone();
        let paths = self.environment.clone();
        let handle = match blocking::run(move || resolve_active_generation(&data, &paths)).await {
            Ok(handle) => handle,
            Err(error) if error.code() == "memory_generation_unavailable" => return Ok(None),
            Err(error) => return Err(error),
        };
        // Include future retry deadlines: an empty due queue must not strand failed work.
        let future = "9999-12-31T23:59:59Z";
        let graph = &handle.graph_path;
        let semantic = self.probe.recoverable_windows(graph).await?
            || self.probe.pending_job(graph, future).await?.is_some()
            || self.probe.cache_work(graph, future).await?;
        let vector_admitted = self.target.is_some()
            || self.vector_batch.load(Ordering::Acquire)
            || self.embedding.as_ref().is_some_and(|owner| owner.is_warm());
        let vectors = vector_admitted && self.probe.vector_work(graph, future).await?;
        Ok((semantic || vectors).then_some(backoff))
    }

    /// Canonical inventory changes invalidate the catch-up interval, preserving missed notices.
    pub fn source_changed(&self) {
        *self.catchup_at.lock() = None;
    }

    /// In-process notices and shutdown retain their coalesced wakeups. The host also
    /// observes external queue/generation/canonical changes before the first poll.
    pub async fn wait_for_work(&self, delay: Option<Duration>) -> bool {
        tokio::select! {
            () = self.shutdown.cancelled() => true,
            () = wake::memory_work_signalled() => true,
            () = async {
                match delay {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => std::future::pending().await,
                }
            } => false,
        }
    }
}
