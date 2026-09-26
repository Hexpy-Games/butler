//! Bounded admission, interactive/background fairness and deadline policy.

use std::{
    collections::VecDeque,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::cognition::{
    CognitionResult, EmbeddingMode, EmbeddingRequest, EmbeddingRequestClass, NativeEmbeddingResult,
};

use super::error;

pub(super) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(super) const MAX_QUEUE_REQUESTS: usize = 64;
pub(super) const MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXTS: usize = 32;
const MAX_BACKGROUND_TEXTS: usize = 4;
const INTERACTIVE_STREAK: usize = 8;

#[derive(Default)]
pub(super) struct QueueState {
    pub(super) interactive: VecDeque<Pending>,
    pub(super) background: VecDeque<Pending>,
    pub(super) queued_requests: usize,
    pub(super) queued_bytes: usize,
    interactive_starts: usize,
    pub(super) active_cancel: Option<CancellationToken>,
    pub(super) closed: bool,
}

pub(super) struct Pending {
    pub(super) id: u64,
    pub(super) frame: Vec<u8>,
    pub(super) bytes: usize,
    pub(super) mode: EmbeddingMode,
    pub(super) requested_texts: usize,
    pub(super) resplit: bool,
    pub(super) max_embeddings: Option<usize>,
    pub(super) cancellation: CancellationToken,
    pub(super) deadline: Option<Instant>,
    pub(super) response: oneshot::Sender<CognitionResult<NativeEmbeddingResult>>,
}

impl QueueState {
    pub(super) fn release(&mut self, bytes: usize) {
        self.queued_requests = self.queued_requests.saturating_sub(1);
        self.queued_bytes = self.queued_bytes.saturating_sub(bytes);
    }

    fn prune(&mut self) {
        let mut released = 0;
        let mut requests = 0;
        for lane in [&mut self.interactive, &mut self.background] {
            let mut retained = VecDeque::with_capacity(lane.len());
            while let Some(item) = lane.pop_front() {
                if item.cancellation.is_cancelled() || expired(item.deadline) {
                    released += item.bytes;
                    requests += 1;
                    let code = if item.cancellation.is_cancelled() {
                        "embed_request_cancelled"
                    } else {
                        "embed_request_deadline"
                    };
                    let _ = item.response.send(Err(error(code)));
                } else {
                    retained.push_back(item);
                }
            }
            *lane = retained;
        }
        self.queued_requests = self.queued_requests.saturating_sub(requests);
        self.queued_bytes = self.queued_bytes.saturating_sub(released);
    }

    pub(super) fn take_next(&mut self) -> Option<Pending> {
        self.prune();
        let next = if !self.background.is_empty()
            && (self.interactive_starts >= INTERACTIVE_STREAK || self.interactive.is_empty())
        {
            self.interactive_starts = 0;
            self.background.pop_front()
        } else if let Some(item) = self.interactive.pop_front() {
            self.interactive_starts += 1;
            Some(item)
        } else {
            self.interactive_starts = 0;
            self.background.pop_front()
        };
        self.active_cancel = next.as_ref().map(|item| item.cancellation.clone());
        next
    }
}

pub(super) fn validate_request(request: &EmbeddingRequest) -> CognitionResult<()> {
    if request.texts.is_empty()
        || request.texts.len() > MAX_TEXTS
        || (request.request_class == EmbeddingRequestClass::Background
            && request.texts.len() > MAX_BACKGROUND_TEXTS)
        || (request.mode == EmbeddingMode::CheckedCls && request.texts.iter().any(String::is_empty))
        || (request.mode == EmbeddingMode::LegacyMean
            && (request.resplit || request.max_embeddings.is_some()))
        || request
            .max_embeddings
            .is_some_and(|count| count == 0 || count > MAX_TEXTS)
    {
        Err(error("embed_invalid_request"))
    } else {
        Ok(())
    }
}

pub(super) fn deadline_instant(epoch_ms: Option<i64>) -> CognitionResult<Option<Instant>> {
    let Some(epoch_ms) = epoch_ms else {
        return Ok(None);
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error("embed_request_deadline"))?
        .as_millis();
    if epoch_ms <= 0 || u128::try_from(epoch_ms).unwrap_or_default() <= now_ms {
        return Err(error("embed_request_deadline"));
    }
    let remaining =
        u64::try_from(u128::try_from(epoch_ms).unwrap_or_default() - now_ms).unwrap_or(u64::MAX);
    Ok(Instant::now().checked_add(Duration::from_millis(remaining)))
}

pub(super) async fn deadline_wait(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await;
    } else {
        std::future::pending::<()>().await;
    }
}

pub(super) fn expired(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|deadline| deadline <= Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(id: u64) -> Pending {
        let (response, _) = oneshot::channel();
        Pending {
            id,
            frame: vec![b'\n'],
            bytes: 1,
            mode: EmbeddingMode::LegacyMean,
            requested_texts: 1,
            resplit: false,
            max_embeddings: None,
            cancellation: CancellationToken::new(),
            deadline: None,
            response,
        }
    }

    #[test]
    fn background_starts_after_eight_interactive_requests() {
        let mut queue = QueueState::default();
        queue.interactive.extend((1..=9).map(pending));
        queue.background.push_back(pending(100));
        queue.queued_requests = 10;
        queue.queued_bytes = 10;
        let selected = (0..10)
            .map(|_| {
                let item = queue.take_next().expect("queued item");
                queue.active_cancel = None;
                queue.release(item.bytes);
                item.id
            })
            .collect::<Vec<_>>();
        assert_eq!(selected, vec![1, 2, 3, 4, 5, 6, 7, 8, 100, 9]);
        assert_eq!((queue.queued_requests, queue.queued_bytes), (0, 0));
    }

    #[test]
    fn cancelled_waiter_releases_capacity_before_start() {
        let mut queue = QueueState::default();
        let item = pending(1);
        item.cancellation.cancel();
        queue.background.push_back(item);
        queue.queued_requests = 1;
        queue.queued_bytes = 1;
        assert!(queue.take_next().is_none());
        assert_eq!((queue.queued_requests, queue.queued_bytes), (0, 0));
    }
}
