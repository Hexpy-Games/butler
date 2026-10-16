//! Owner-controlled loading and cancellable inference.
use super::*;

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
        () = item.cancellation.cancelled() => Err(error(CognitionCode::EmbedRequestCancelled)),
        () = deadline_wait(item.deadline) => Err(error(CognitionCode::EmbedRequestDeadline)),
        result = exchange(process, item) => result,
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
        if !item.cold_start_allowed {
            return Err(error(CognitionCode::EmbedWorkerCold));
        }
        *child = Some(spawn_worker(&inner.executable, &inner.data_root, item.background).await?);
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
        result = tokio::time::timeout(Duration::from_secs(300), initialize(process, id)) =>
            result.unwrap_or_else(|_| Err(error(CognitionCode::EmbedWorkerUnavailable))),
    }
}
