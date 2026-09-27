//! Host-owned, bounded client for the private same-executable embedding worker.
//! One in-process queue serializes one child and one inference at a time.

use butler_memory::cognition::CognitionCode;
use parking_lot::Mutex;
use std::{
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
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

mod queue;
#[cfg(test)]
mod tests;
mod wire;

use wire::{WorkerChild, exchange, initialize, kill_and_reap, spawn_worker};

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
        let executable = std::env::current_exe()
            .map_err(|source| error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?;
        let inner = Arc::new(Inner {
            data_root,
            executable,
            next_id: AtomicU64::new(1),
            state: Mutex::new(QueueState::default()),
            notify: Notify::new(),
            shutdown: CancellationToken::new(),
        });
        let (completion_tx, completion) = watch::channel(None);
        let actor_inner = inner.clone();
        let actor = tokio::spawn(async move {
            let completed = AssertUnwindSafe(run_actor(actor_inner))
                .catch_unwind()
                .await
                .is_ok();
            completion_tx.send_replace(Some(completed));
        });
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

    async fn embed_request(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> CognitionResult<EmbeddingResult> {
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
        {
            let mut state = self.inner.state.lock();
            if state.closed {
                return Err(error(CognitionCode::EmbedOwnerClosed));
            }
            if state.queued_requests >= MAX_QUEUE_REQUESTS
                || state.queued_bytes + bytes > MAX_QUEUE_BYTES
            {
                return Err(error(CognitionCode::EmbedQueueFull));
            }
            let pending = Pending {
                id,
                frame,
                bytes,
                mode,
                requested_texts,
                resplit,
                max_embeddings,
                cancellation: admitted_cancel.clone(),
                deadline,
                response: sender,
            };
            state.queued_requests += 1;
            state.queued_bytes += bytes;
            match request.request_class {
                EmbeddingRequestClass::Interactive => state.interactive.push_back(pending),
                EmbeddingRequestClass::Background => state.background.push_back(pending),
            }
        }
        self.inner.notify.notify_one();
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
    fn embed(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'_> {
        Box::pin(self.embed_request(request, cancellation))
    }
}

impl Inner {
    fn close(&self) {
        let mut state = self.state.lock();
        if state.closed {
            return;
        }
        state.closed = true;
        for pending in state.interactive.drain(..) {
            let _ = pending
                .response
                .send(Err(error(CognitionCode::EmbedOwnerClosed)));
        }
        for pending in state.background.drain(..) {
            let _ = pending
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
    loop {
        let next = {
            let mut state = inner.state.lock();
            if state.closed {
                None
            } else {
                state.take_next()
            }
        };
        if let Some(item) = next {
            let result = run_item(&inner, &mut child, &item).await;
            let _ = item.response.send(result);
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
                _ = process.child.wait() => { child = None; },
            }
        } else {
            tokio::select! {
                () = inner.notify.notified() => {},
                () = inner.shutdown.cancelled() => {},
            }
        }
    }
    kill_and_reap(&mut child).await;
}

async fn run_item(
    inner: &Inner,
    child: &mut Option<WorkerChild>,
    item: &Pending,
) -> CognitionResult<EmbeddingResult> {
    if item.cancellation.is_cancelled() {
        return Err(error(CognitionCode::EmbedRequestCancelled));
    }
    if expired(item.deadline) {
        return Err(error(CognitionCode::EmbedRequestDeadline));
    }
    if child
        .as_mut()
        .is_some_and(|process| process.child.try_wait().ok().flatten().is_some())
    {
        *child = None;
    }
    if child.is_none() {
        *child = Some(spawn_worker(&inner.executable, &inner.data_root)?);
    }
    if let Some(process) = child.as_mut().filter(|process| !process.initialized) {
        let initialized = tokio::select! {
            biased;
            () = inner.shutdown.cancelled() => Err(error(CognitionCode::EmbedOwnerClosed)),
            result = tokio::time::timeout(Duration::from_secs(300), initialize(process, item.id)) =>
                result.unwrap_or_else(|_| Err(error(CognitionCode::EmbedWorkerUnavailable))),
        };
        match initialized {
            Ok(()) => process.initialized = true,
            Err(failure) => {
                kill_and_reap(child).await;
                return Err(failure);
            }
        }
    }
    // Initialization belongs to the owner. An initiating caller may have
    // timed out while the same child became ready for later live requests.
    if item.cancellation.is_cancelled() {
        return Err(error(CognitionCode::EmbedRequestCancelled));
    }
    if expired(item.deadline) {
        return Err(error(CognitionCode::EmbedRequestDeadline));
    }
    let Some(process) = child.as_mut() else {
        return Err(error(CognitionCode::EmbedWorkerUnavailable));
    };
    let outcome = tokio::select! {
        biased;
        () = inner.shutdown.cancelled() => Err(error(CognitionCode::EmbedOwnerClosed)),
        () = item.cancellation.cancelled() => Err(error(CognitionCode::EmbedRequestCancelled)),
        () = deadline_wait(item.deadline) => Err(error(CognitionCode::EmbedRequestDeadline)),
        result = exchange(process, item) => result,
    };
    match outcome {
        Ok(result) => result,
        Err(failure) => {
            kill_and_reap(child).await;
            Err(failure)
        }
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
