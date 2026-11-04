//! Host-owned, bounded client for the private same-executable embedding worker.
//! One in-process queue serializes one child and one inference at a time.

use butler_memory::cognition::CognitionCode;
use parking_lot::Mutex;
use std::{
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
};

use futures_util::FutureExt;
use tokio::{
    sync::{Notify, oneshot, watch},
    task::JoinHandle,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::{
    CognitionEmbeddingPort, CognitionError, CognitionResult, EmbeddingFuture, EmbeddingMode,
    EmbeddingRequest, EmbeddingRequestClass, EmbeddingResult, WorkerOperation, WorkerRequest,
};

mod drain_barrier;
mod execute;
mod queue;
mod readiness;
mod supervision;

use execute::run_item;
use queue::PendingResponse;
use readiness::WorkerReadiness;
#[cfg(test)]
mod prewarm_tests;
#[cfg(test)]
mod readiness_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod verification_tests;
mod wire;

use wire::{WorkerChild, initialize, kill_and_reap, receive_embedding, send_frame, spawn_worker};

const WORKER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);

use queue::{
    MAX_FRAME_BYTES, MAX_QUEUE_BYTES, MAX_QUEUE_REQUESTS, Pending, QueueState, deadline_instant,
    deadline_wait, expired, validate_request,
};

pub(crate) struct EmbeddingOwner {
    inner: Arc<Inner>,
    actor: Mutex<Option<JoinHandle<()>>>,
    completion: watch::Receiver<Option<bool>>,
}

struct Inner {
    data_root: PathBuf,
    executable: PathBuf,
    next_id: AtomicU64,
    readiness: WorkerReadiness,
    /// The user's memory-model choice with the model present; off starts no child.
    enabled: AtomicBool,
    /// A switch to off asks the actor to reap a live child.
    release: AtomicBool,
    /// Wakes a model load waiting on `release`.
    release_signal: Notify,
    /// True while no worker child is alive.
    released: watch::Sender<bool>,
    state: Mutex<QueueState>,
    notify: Notify,
    shutdown: CancellationToken,
}

struct AdmissionGuard {
    inner: Arc<Inner>,
    id: u64,
    cancellation: CancellationToken,
}

impl EmbeddingOwner {
    pub(crate) fn new(data_root: PathBuf) -> CognitionResult<Self> {
        let executable = butler_platform::process_names::current_exe()
            .map_err(|source| error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?;
        let inner = Arc::new(Inner {
            data_root,
            executable,
            next_id: AtomicU64::new(1),
            readiness: WorkerReadiness::default(),
            enabled: AtomicBool::new(false),
            release: AtomicBool::new(false),
            release_signal: Notify::new(),
            released: watch::channel(true).0,
            state: Mutex::new(QueueState::default()),
            notify: Notify::new(),
            shutdown: CancellationToken::new(),
        });
        let (completion_tx, completion) = watch::channel(None);
        let actor_inner = inner.clone();
        let actor = tokio::spawn(supervision::supervise(
            inner.clone(),
            completion_tx,
            run_actor(actor_inner),
        ));
        Ok(Self {
            inner,
            actor: Mutex::new(Some(actor)),
            completion,
        })
    }

    pub(crate) async fn close(&self) -> CognitionResult<()> {
        self.inner.close();
        let mut completion = self.completion.clone();
        loop {
            let completed = *completion.borrow_and_update();
            if let Some(completed) = completed {
                let actor = self.actor.lock().take();
                if let Some(actor) = actor {
                    actor.await.map_err(|source| {
                        error(CognitionCode::EmbedWorkerUnavailable).with_source(source)
                    })?;
                }
                return if completed {
                    Ok(())
                } else {
                    Err(error(CognitionCode::EmbedWorkerUnavailable))
                };
            }
            completion.changed().await.map_err(|source| {
                error(CognitionCode::EmbedWorkerUnavailable).with_source(source)
            })?;
        }
    }

    /// The model is chosen and present: requests may start the worker.
    pub(crate) fn enable(&self) {
        self.inner.enabled.store(true, Ordering::Release);
    }

    /// Turning the model off fails queued work as cold (units stay pending without
    /// an attempt), cancels the active request, model load included, and waits
    /// until the worker has actually been reaped, so its files can be deleted
    /// (Windows refuses to delete files a live process holds).
    pub(crate) async fn disable(&self) {
        self.inner.enabled.store(false, Ordering::Release);
        self.inner.readiness.clear();
        self.inner.release.store(true, Ordering::Release);
        self.inner.release_signal.notify_waiters();
        self.inner.released.send_replace(false);
        if let Some(active) = self.inner.state.lock().active_cancel.as_ref() {
            active.cancel();
        }
        self.inner.notify.notify_one();
        let mut released = self.inner.released.subscribe();
        let mut completion = self.completion.clone();
        // A finished actor has reaped its child; it cannot report release again.
        tokio::select! {
            _ = released.wait_for(|free| *free) => {}
            _ = completion.wait_for(Option::is_some) => {}
        }
    }

    async fn embed_request(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> CognitionResult<EmbeddingResult> {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return Err(error(CognitionCode::EmbedWorkerCold));
        }
        validate_request(&request)?;
        // The source socket uses 300 seconds when its caller supplies no
        // deadline; checked projection supplies its own 30-second deadline.
        let deadline = deadline_instant(request.deadline_at_epoch_ms)?
            .or_else(|| Instant::now().checked_add(Duration::from_secs(300)));
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::EmbedRequestCancelled));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let mode = request.mode;
        let requested_texts = request.texts.len();
        let resplit = request.resplit;
        let max_embeddings = request.max_embeddings;
        let interactive_query = execute::drainable_query(&request);
        let wire = WorkerRequest {
            id,
            op: WorkerOperation::Embed,
            texts: request.texts,
            checked: request.mode == EmbeddingMode::CheckedCls,
            resplit: request.resplit,
            max_embeddings: request.max_embeddings,
        };
        let mut frame = serde_json::to_vec(&wire)
            .map_err(|source| error(CognitionCode::EmbedInvalidRequest).with_source(source))?;
        frame.push(b'\n');
        if frame.len() > MAX_FRAME_BYTES {
            return Err(error(CognitionCode::EmbedRequestTooLarge));
        }
        let bytes = frame.len();
        let admitted_cancel = cancellation.child_token();
        let (sender, receiver) = oneshot::channel();
        let pending = Pending {
            id,
            frame,
            bytes,
            mode,
            requested_texts,
            resplit,
            max_embeddings,
            request_class: request.request_class,
            interactive_query,
            cancellation: admitted_cancel.clone(),
            deadline,
            response: PendingResponse::Embedding(sender),
        };
        self.inner.enqueue(pending, request.request_class)?;
        let _guard = AdmissionGuard {
            inner: self.inner.clone(),
            id,
            cancellation: admitted_cancel.clone(),
        };
        let response = async {
            receiver.await.map_err(|source| {
                error(CognitionCode::EmbedWorkerUnavailable).with_source(source)
            })?
        };
        tokio::select! {
            biased;
            () = admitted_cancel.cancelled() => Err(error(CognitionCode::EmbedRequestCancelled)),
            () = deadline_wait(deadline) => Err(error(CognitionCode::EmbedRequestDeadline)),
            result = response => result,
        }
    }
}

impl Drop for EmbeddingOwner {
    fn drop(&mut self) {
        self.inner.close();
    }
}

impl CognitionEmbeddingPort for EmbeddingOwner {
    fn is_warm(&self) -> bool {
        self.enabled() && self.inner.readiness.is_warm()
    }

    fn enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
    }

    fn ready(
        &self,
        deadline_at_epoch_ms: i64,
    ) -> butler_memory::cognition::EmbeddingReadyFuture<'_> {
        Box::pin(self.await_ready(deadline_at_epoch_ms))
    }

    fn embed(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'_> {
        Box::pin(self.embed_request(request, cancellation))
    }
}

impl Inner {
    fn enqueue(&self, pending: Pending, class: EmbeddingRequestClass) -> CognitionResult<()> {
        let mut state = self.state.lock();
        if state.closed {
            return Err(error(CognitionCode::EmbedOwnerClosed));
        }
        // Only another queued, owner-owned prewarm guarantees a future check/load.
        // Active work can be failing; caller-owned work can expire or cancel.
        if matches!(pending.response, PendingResponse::Prewarm)
            && state
                .interactive
                .iter()
                .chain(&state.background)
                .any(|item| matches!(item.response, PendingResponse::Prewarm))
        {
            return Ok(());
        }
        if state.queued_requests >= MAX_QUEUE_REQUESTS
            || state.queued_bytes + pending.bytes > MAX_QUEUE_BYTES
        {
            return Err(error(CognitionCode::EmbedQueueFull));
        }
        state.queued_requests += 1;
        state.queued_bytes += pending.bytes;
        if std::env::var("BUTLER_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
            butler_core::diagnostic!(
                "[embedding-worker] queued class={class:?} texts={}",
                pending.requested_texts
            );
        }
        match class {
            EmbeddingRequestClass::Interactive | EmbeddingRequestClass::WarmInteractive => {
                state.interactive.push_back(pending);
            }
            EmbeddingRequestClass::Background | EmbeddingRequestClass::WarmBackground => {
                state.background.push_back(pending);
            }
        }
        drop(state);
        self.notify.notify_one();
        Ok(())
    }

    fn close(&self) {
        let mut state = self.state.lock();
        if state.closed {
            return;
        }
        state.closed = true;
        self.readiness.clear();
        for pending in state.interactive.drain(..) {
            pending
                .response
                .send(Err(error(CognitionCode::EmbedOwnerClosed)));
        }
        for pending in state.background.drain(..) {
            pending
                .response
                .send(Err(error(CognitionCode::EmbedOwnerClosed)));
        }
        state.active_cancel.as_ref().map(CancellationToken::cancel);
        state.queued_requests = usize::from(state.active_cancel.is_some());
        state.queued_bytes = 0;
        drop(state);
        self.shutdown.cancel();
        self.notify.notify_waiters();
    }

    fn remove_waiting(&self, id: u64) {
        let mut state = self.state.lock();
        let removed = state
            .interactive
            .iter()
            .position(|item| item.id == id)
            .and_then(|position| state.interactive.remove(position))
            .or_else(|| {
                state
                    .background
                    .iter()
                    .position(|item| item.id == id)
                    .and_then(|position| state.background.remove(position))
            });
        if let Some(item) = removed {
            state.release(item.bytes);
        }
        drop(state);
        self.notify.notify_one();
    }
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.inner.remove_waiting(self.id);
    }
}

async fn run_actor(inner: Arc<Inner>) {
    let mut child: Option<WorkerChild> = None;
    #[cfg(feature = "e2e-fixtures")]
    initialize_for_ownership_test(&inner, &mut child).await;
    run_loop(
        &inner,
        &mut child,
        butler_memory::cognition::signal_memory_work,
    )
    .await;
}

async fn run_loop(inner: &Inner, child: &mut Option<WorkerChild>, signal_memory_work: impl Fn()) {
    loop {
        if inner.release.swap(false, Ordering::AcqRel) {
            inner.readiness.clear();
            kill_and_reap(child).await;
        }
        inner.released.send_replace(child.is_none());
        let next = {
            let mut state = inner.state.lock();
            if state.closed {
                None
            } else {
                state.take_next()
            }
        };
        if let Some(item) = next {
            let previous_worker = child
                .as_ref()
                .filter(|process| process.initialized)
                .and_then(|process| process.child.id());
            let result = run_item(inner, child, &item).await;
            let ready = inner.enabled.load(Ordering::Acquire)
                && !inner.shutdown.is_cancelled()
                && child.as_ref().is_some_and(|process| process.initialized);
            if inner.readiness.publish(ready) {
                signal_memory_work();
            }
            if ready && child.as_ref().and_then(|process| process.child.id()) != previous_worker {
                butler_core::diagnostic!("[embedding-worker] ready");
            }
            item.response.send(result);
            let mut state = inner.state.lock();
            state.active_cancel = None;
            state.release(item.bytes);
            continue;
        }
        if inner.shutdown.is_cancelled() {
            break;
        }
        if let Some(process) = child.as_mut() {
            tokio::select! {
                () = inner.notify.notified() => {},
                () = inner.shutdown.cancelled() => {},
                _ = process.child.wait() => { *child = None; inner.readiness.clear(); },
            }
        } else {
            tokio::select! {
                () = inner.notify.notified() => {},
                () = inner.shutdown.cancelled() => {},
            }
        }
    }
    inner.readiness.clear();
    kill_and_reap(child).await;
    inner.released.send_replace(true);
}

// Exercise the normal native owner/worker protocol during a held CPU load.
// An E2E fixture flag allows supervision E2Es to cover startup ownership.
#[cfg(feature = "e2e-fixtures")]
async fn initialize_for_ownership_test(inner: &Inner, child: &mut Option<WorkerChild>) {
    if std::env::var_os("BUTLER_E2E_EMBED_INIT_BARRIER").is_none() {
        return;
    }
    let Ok(process) = spawn_worker(&inner.executable, &inner.data_root, false).await else {
        return;
    };
    *child = Some(process);
    if let Some(process) = child.as_mut() {
        tokio::select! {
            () = inner.shutdown.cancelled() => {},
            _ = initialize(process, 0) => {},
        }
    }
}

/// Resolves once a switch to off asks for the worker's release.
async fn release_requested(inner: &Inner) {
    loop {
        let notified = inner.release_signal.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if inner.release.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
