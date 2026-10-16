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
        self.enqueue_readiness(
            id,
            cancellation.clone(),
            deadline,
            PendingResponse::Ready(sender),
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

    /// Best-effort turn prefetch; queue ownership keeps loading after this returns.
    pub(crate) fn start_loading(&self) {
        if !self.enabled() {
            return;
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let _ =
            self.enqueue_readiness(id, CancellationToken::new(), None, PendingResponse::Prewarm);
    }

    fn enqueue_readiness(
        &self,
        id: u64,
        cancellation: CancellationToken,
        deadline: Option<Instant>,
        response: PendingResponse,
    ) -> CognitionResult<()> {
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
                cancellation,
                deadline,
                response,
            },
            EmbeddingRequestClass::Interactive,
        )
    }
}
