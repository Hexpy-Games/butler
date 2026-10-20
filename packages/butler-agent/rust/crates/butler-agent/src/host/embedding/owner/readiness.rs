//! Readiness requests share the bounded owner queue and its single model load.
use super::*;

const COLD: u8 = 0;
const WARM: u8 = 1;
const VERIFYING: u8 = 2;

/// One atomic observation prevents a readiness caller from combining warmth
/// from before a failed verification with verification completion after it.
#[derive(Default)]
pub(super) struct WorkerReadiness(AtomicU8);

impl WorkerReadiness {
    pub(super) fn is_warm(&self) -> bool {
        self.0.load(Ordering::Acquire) != COLD
    }

    fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire) == WARM
    }

    pub(super) fn clear(&self) {
        self.0.store(COLD, Ordering::Release);
    }

    pub(super) fn begin_verification(&self) {
        let _ = self
            .0
            .compare_exchange(WARM, VERIFYING, Ordering::AcqRel, Ordering::Acquire);
    }

    pub(super) fn finish_verification(&self) {
        // Off/close may already have revoked warmth while the exchange ran.
        let _ = self
            .0
            .compare_exchange(VERIFYING, WARM, Ordering::AcqRel, Ordering::Acquire);
    }

    /// True only when a cold worker becomes warm; verification is already warm.
    pub(super) fn publish(&self, ready: bool) -> bool {
        self.0
            .swap(if ready { WARM } else { COLD }, Ordering::AcqRel)
            == COLD
            && ready
    }
}

impl EmbeddingOwner {
    pub(super) async fn await_ready(&self, deadline_at: i64) -> CognitionResult<()> {
        if !self.enabled() {
            return Err(error(CognitionCode::EmbedWorkerCold));
        }
        self.inner.admit_background();
        if self.inner.readiness.is_ready() {
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
        if self.enabled() {
            self.inner.admit_background();
            self.prepare();
        }
    }

    /// Speculative preparation never admits deferred projection on its own.
    pub(crate) fn prepare(&self) {
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

impl Inner {
    pub(super) fn admit_background(&self) {
        if !self.background_admitted.swap(true, Ordering::AcqRel) && self.readiness.is_warm() {
            butler_memory::cognition::signal_memory_work();
        }
    }
}
