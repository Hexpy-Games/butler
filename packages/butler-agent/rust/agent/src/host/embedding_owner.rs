//! Host-owned, bounded client for the private same-executable embedding worker.
//! One in-process queue serializes one child and one inference at a time.

use std::{
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{
        Arc, Mutex,
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

use crate::cognition::{
    CognitionEmbeddingPort, CognitionError, CognitionResult, EmbeddingFuture, EmbeddingMode,
    EmbeddingRequest, EmbeddingRequestClass, NativeEmbeddingResult, WorkerOperation, WorkerRequest,
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

pub(crate) struct NativeEmbeddingOwner {
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

impl NativeEmbeddingOwner {
    pub(crate) fn new(data_root: PathBuf) -> CognitionResult<Self> {
        let executable = std::env::current_exe().map_err(|_| error("embed_worker_unavailable"))?;
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
                let actor = self.actor.lock().expect("embedding actor mutex").take();
                if let Some(actor) = actor {
                    actor.await.map_err(|_| error("embed_worker_unavailable"))?;
                }
                return if completed {
                    Ok(())
                } else {
                    Err(error("embed_worker_unavailable"))
                };
            }
            completion
                .changed()
                .await
                .map_err(|_| error("embed_worker_unavailable"))?;
        }
    }

    async fn embed_request(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> CognitionResult<NativeEmbeddingResult> {
        validate_request(&request)?;
        // The source socket uses 300 seconds when its caller supplies no
        // deadline; checked projection supplies its own 30-second deadline.
        let deadline = deadline_instant(request.deadline_at_epoch_ms)?
            .or_else(|| Instant::now().checked_add(Duration::from_secs(300)));
        if cancellation.is_cancelled() {
            return Err(error("embed_request_cancelled"));
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
        let mut frame = serde_json::to_vec(&wire).map_err(|_| error("embed_invalid_request"))?;
        frame.push(b'\n');
        if frame.len() > MAX_FRAME_BYTES {
            return Err(error("embed_request_too_large"));
        }
        let bytes = frame.len();
        let admitted_cancel = cancellation.child_token();
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.inner.state.lock().expect("embedding queue mutex");
            if state.closed {
                return Err(error("embed_owner_closed"));
            }
            if state.queued_requests >= MAX_QUEUE_REQUESTS
                || state.queued_bytes + bytes > MAX_QUEUE_BYTES
            {
                return Err(error("embed_queue_full"));
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
            receiver
                .await
                .map_err(|_| error("embed_worker_unavailable"))?
        };
        tokio::select! {
            biased;
            _ = admitted_cancel.cancelled() => Err(error("embed_request_cancelled")),
            _ = deadline_wait(deadline) => Err(error("embed_request_deadline")),
            result = response => result,
        }
    }
}

impl Drop for NativeEmbeddingOwner {
    fn drop(&mut self) {
        self.inner.close();
    }
}

impl CognitionEmbeddingPort for NativeEmbeddingOwner {
    fn embed<'a>(
        &'a self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'a> {
        Box::pin(self.embed_request(request, cancellation))
    }
}

impl Inner {
    fn close(&self) {
        let mut state = self.state.lock().expect("embedding queue mutex");
        if state.closed {
            return;
        }
        state.closed = true;
        for pending in state.interactive.drain(..) {
            let _ = pending.response.send(Err(error("embed_owner_closed")));
        }
        for pending in state.background.drain(..) {
            let _ = pending.response.send(Err(error("embed_owner_closed")));
        }
        state.active_cancel.as_ref().map(CancellationToken::cancel);
        state.queued_requests = usize::from(state.active_cancel.is_some());
        state.queued_bytes = 0;
        drop(state);
        self.shutdown.cancel();
        self.notify.notify_waiters();
    }

    fn remove_waiting(&self, id: u64) {
        let mut state = self.state.lock().expect("embedding queue mutex");
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
            let mut state = inner.state.lock().expect("embedding queue mutex");
            if state.closed {
                None
            } else {
                state.take_next()
            }
        };
        if let Some(item) = next {
            let result = run_item(&inner, &mut child, &item).await;
            let _ = item.response.send(result);
            let mut state = inner.state.lock().expect("embedding queue mutex");
            state.active_cancel = None;
            state.release(item.bytes);
            continue;
        }
        if inner.shutdown.is_cancelled() {
            break;
        }
        if let Some(process) = child.as_mut() {
            tokio::select! {
                _ = inner.notify.notified() => {},
                _ = inner.shutdown.cancelled() => {},
                _ = process.child.wait() => { child = None; },
            }
        } else {
            tokio::select! {
                _ = inner.notify.notified() => {},
                _ = inner.shutdown.cancelled() => {},
            }
        }
    }
    kill_and_reap(&mut child).await;
}

async fn run_item(
    inner: &Inner,
    child: &mut Option<WorkerChild>,
    item: &Pending,
) -> CognitionResult<NativeEmbeddingResult> {
    if item.cancellation.is_cancelled() {
        return Err(error("embed_request_cancelled"));
    }
    if expired(item.deadline) {
        return Err(error("embed_request_deadline"));
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
    if !child.as_ref().expect("spawned above").initialized {
        let process = child.as_mut().expect("spawned above");
        let initialized = tokio::select! {
            biased;
            _ = inner.shutdown.cancelled() => Err(error("embed_owner_closed")),
            result = tokio::time::timeout(Duration::from_secs(300), initialize(process, item.id)) =>
                result.unwrap_or_else(|_| Err(error("embed_worker_unavailable"))),
        };
        if let Err(failure) = initialized {
            kill_and_reap(child).await;
            return Err(failure);
        }
        child.as_mut().expect("initialized above").initialized = true;
    }
    // Initialization belongs to the owner. An initiating caller may have
    // timed out while the same child became ready for later live requests.
    if item.cancellation.is_cancelled() {
        return Err(error("embed_request_cancelled"));
    }
    if expired(item.deadline) {
        return Err(error("embed_request_deadline"));
    }
    let process = child.as_mut().expect("spawned above");
    let outcome = tokio::select! {
        biased;
        _ = inner.shutdown.cancelled() => Err(error("embed_owner_closed")),
        _ = item.cancellation.cancelled() => Err(error("embed_request_cancelled")),
        _ = deadline_wait(item.deadline) => Err(error("embed_request_deadline")),
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

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
