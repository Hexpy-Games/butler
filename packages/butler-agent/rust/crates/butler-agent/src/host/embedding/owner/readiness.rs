//! Readiness requests share the bounded owner queue and its single model load.
use super::*;

impl EmbeddingOwner {
    pub(super) async fn await_ready(&self, deadline_at: i64) -> CognitionResult<()> {
        if !self.enabled() {
            return Err(error(CognitionCode::EmbedWorkerCold));
        }
        if self.is_warm() {
            return Ok(());
        }
        let deadline = deadline_instant(Some(deadline_at))?;
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationToken::new();
        let (sender, receiver) = oneshot::channel();
        self.inner.enqueue(
            Pending {
                id,
                frame: Vec::new(),
                bytes: 0,
                cold_start_allowed: true,
                background: false,
                mode: EmbeddingMode::CheckedCls,
                requested_texts: 0,
                resplit: false,
                max_embeddings: None,
                cancellation: cancellation.clone(),
                deadline,
                response: PendingResponse::Ready(sender),
            },
            EmbeddingRequestClass::Interactive,
        )?;
        let _guard = AdmissionGuard {
            inner: self.inner.clone(),
            id,
            cancellation,
        };
        tokio::select! {
            () = deadline_wait(deadline) => Err(error(CognitionCode::EmbedRequestDeadline)),
            result = receiver => result.map_err(|source|
                error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?,
        }
    }
}
