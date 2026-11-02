//! Owner-controlled loading and cancellable inference.
use super::*;

// WSL x86_64, BGE-M3 quantized, 2026-10-20: three newly loaded sessions per
// input; 512 ASCII bytes / 473 tokens took 267.151–272.619 ms, and four
// 128-byte queries took 221.576–231.672 ms. Reserve twice the rounded-up worst
// inference: 2 * ceil(272.619) = 546 ms. The measured envelope is <=512 total
// input bytes and <=4 vectors; larger work keeps kill-at-deadline, not a longer
// grace. This changes worker retention only, never the request or its content.
const QUERY_DRAIN_GRACE: Duration = Duration::from_millis(2 * 273);

pub(super) fn drainable_query(request: &EmbeddingRequest) -> bool {
    request.request_class == EmbeddingRequestClass::Interactive
        && request.mode == EmbeddingMode::CheckedCls
        && request.resplit
        && request.max_embeddings.is_some_and(|limit| limit <= 4)
        && request.texts.iter().map(String::len).sum::<usize>() <= 512
}

pub(super) async fn run_item(
    inner: &Inner,
    child: &mut Option<WorkerChild>,
    item: &Pending,
) -> CognitionResult<Option<EmbeddingResult>> {
    if !inner.enabled.load(Ordering::Acquire) {
        return Err(error(CognitionCode::EmbedWorkerCold));
    }
    if item.cancellation.is_cancelled() {
        return Err(error(CognitionCode::EmbedRequestCancelled));
    }
    if expired(item.deadline) {
        return Err(error(CognitionCode::EmbedRequestDeadline));
    }
    ensure_initialized(inner, child, item).await?;
    // Initialization belongs to the owner. An initiating caller may have
    // timed out while the same child became ready for later live requests.
    if item.cancellation.is_cancelled() {
        return Err(error(CognitionCode::EmbedRequestCancelled));
    }
    if expired(item.deadline) {
        return Err(error(CognitionCode::EmbedRequestDeadline));
    }
    if matches!(
        item.response,
        PendingResponse::Ready(_) | PendingResponse::Prewarm
    ) {
        return Ok(None);
    }
    let Some(process) = child.as_mut() else {
        return Err(error(CognitionCode::EmbedWorkerUnavailable));
    };
    let outcome = tokio::select! {
        biased;
        () = inner.shutdown.cancelled() => Err(error(CognitionCode::EmbedOwnerClosed)),
        () = release_requested(inner) => Err(error(CognitionCode::EmbedRequestCancelled)),
        result = exchange_owned(process, item) => result,
    };
    match outcome {
        Ok(result) => result.map(Some),
        Err(failure) => {
            inner.readiness.clear();
            kill_and_reap(child).await;
            Err(failure)
        }
    }
}

// Drain only sent interactive queries. Every other request retains the normal
// kill-at-deadline/cancellation policy, including checked projection batches.
async fn exchange_owned(
    process: &mut WorkerChild,
    item: &Pending,
) -> CognitionResult<CognitionResult<EmbeddingResult>> {
    tokio::select! {
        biased;
        () = item.cancellation.cancelled() => return Err(error(CognitionCode::EmbedRequestCancelled)),
        () = deadline_wait(item.deadline) => return Err(error(CognitionCode::EmbedRequestDeadline)),
        result = send_frame(process, &item.frame) => result?,
    }
    let response = receive_embedding(process, item);
    tokio::pin!(response);
    tokio::select! {
        biased;
        () = item.cancellation.cancelled() => {
            // A live caller can explicitly cancel. A dropped receiver has only
            // abandoned its result, so finish this sent request for the owner.
            if !item.interactive_query || !item.response.is_closed() {
                return Err(error(CognitionCode::EmbedRequestCancelled));
            }
        }
        () = deadline_wait(item.deadline) => {
            if !item.interactive_query {
                return Err(error(CognitionCode::EmbedRequestDeadline));
            }
        }
        result = &mut response => return result,
    }
    drain_query(item, response).await
}

async fn drain_query(
    item: &Pending,
    response: impl std::future::Future<Output = CognitionResult<CognitionResult<EmbeddingResult>>>,
) -> CognitionResult<CognitionResult<EmbeddingResult>> {
    tokio::pin!(response);
    // An early drop gets at most one grace too; a late cancellation cannot
    // restart the clock after the original deadline.
    let start = item
        .deadline
        .unwrap_or_else(Instant::now)
        .min(Instant::now());
    let deadline = start + QUERY_DRAIN_GRACE;
    if std::env::var("BUTLER_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
        butler_core::diagnostic!(
            "[embedding-worker] draining query grace_ms={}",
            QUERY_DRAIN_GRACE.as_millis()
        );
    }
    // A stub scenario may hold here until it has queued its second request;
    // the real grace then starts from the release.
    let deadline = if super::drain_barrier::reached().await {
        Instant::now() + QUERY_DRAIN_GRACE
    } else {
        deadline
    };
    // Queued work waits for this bounded exchange to preserve the loaded
    // worker and frame synchronization. Its own deadline is pruned on dequeue.
    tokio::select! {
        biased;
        result = &mut response => result,
        () = tokio::time::sleep_until(deadline) => {
            if std::env::var("BUTLER_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
                butler_core::diagnostic!("[embedding-worker] drain_end=deadline");
            }
            Err(error(CognitionCode::EmbedRequestDeadline))
        },
    }
}

async fn ensure_initialized(
    inner: &Inner,
    child: &mut Option<WorkerChild>,
    item: &Pending,
) -> CognitionResult<()> {
    if child
        .as_mut()
        .is_some_and(|process| process.child.try_wait().ok().flatten().is_some())
    {
        *child = None;
        inner.readiness.clear();
    }
    // A child can still be alive while disposing its idle model. Confirm it
    // accepts work, instead of treating an initialized process handle as ready.
    if matches!(item.response, PendingResponse::Prewarm)
        && let Some(process) = child.as_mut().filter(|process| process.initialized)
    {
        inner.readiness.begin_verification();
        let verified = initialize_owned(inner, process, item.id).await;
        if verified.is_err() {
            // Revoke warmth before yielding to reap a worker known to be unusable.
            inner.readiness.clear();
            kill_and_reap(child).await;
        }
        inner.readiness.finish_verification();
    }
    if child.is_none() {
        if !inner.enabled.load(Ordering::Acquire) {
            return Err(error(CognitionCode::EmbedWorkerCold));
        }
        if inner.shutdown.is_cancelled() {
            return Err(error(CognitionCode::EmbedOwnerClosed));
        }
        if !matches!(
            item.request_class,
            EmbeddingRequestClass::Interactive | EmbeddingRequestClass::Background
        ) {
            return Err(error(CognitionCode::EmbedWorkerCold));
        }
        let started = Instant::now();
        let background = item.request_class == EmbeddingRequestClass::Background;
        *child = Some(spawn_worker(&inner.executable, &inner.data_root, background).await?);
        if std::env::var("BUTLER_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
            butler_core::diagnostic!(
                "[embedding-worker] spawn_ms={:.3}",
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
        inner.released.send_replace(false);
    }
    if let Some(process) = child.as_mut().filter(|process| !process.initialized) {
        let load_started = Instant::now();
        let initialized = initialize_owned(inner, process, item.id).await;
        match initialized {
            Ok(()) => {
                process.initialized = true;
                butler_core::diagnostic!(
                    "[embedding-worker] initialized load_ms={}",
                    load_started.elapsed().as_millis()
                );
            }
            Err(failure) => {
                kill_and_reap(child).await;
                return Err(failure);
            }
        }
    }
    Ok(())
}

// A load outlives a caller that gave up, but not shutdown or a switch to off.
async fn initialize_owned(
    inner: &Inner,
    process: &mut WorkerChild,
    id: u64,
) -> CognitionResult<()> {
    tokio::select! {
        biased;
        () = inner.shutdown.cancelled() => Err(error(CognitionCode::EmbedOwnerClosed)),
        () = release_requested(inner) => Err(error(CognitionCode::EmbedRequestCancelled)),
        result = tokio::time::timeout(WORKER_RESPONSE_TIMEOUT, initialize(process, id)) =>
            result.unwrap_or_else(|_| Err(error(CognitionCode::EmbedWorkerUnavailable))),
    }
}
