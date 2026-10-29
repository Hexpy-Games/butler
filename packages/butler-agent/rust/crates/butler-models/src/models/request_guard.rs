//! One physical request owns its operation, cancellation and inline deadlines.
//! No task, listener registry or per-Turn map survives this future.
//!
//! Until an attempt's first output event (text, reasoning or a tool call)
//! arrives only the total limit applies: a slow prefill sends no output and
//! is not a stall. After it, the idle limit detects a stream that stops.

use parking_lot::Mutex;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug)]
pub(super) struct RequestPolicy {
    pub total: Duration,
    pub idle: Option<Duration>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TimeoutKind {
    /// The total limit passed before the attempt's first output event.
    FirstResponse,
    Total,
    Idle,
}

impl TimeoutKind {
    /// The `timeout_kind` a provider error reports.
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::FirstResponse => "first_response",
            Self::Total => "total",
            Self::Idle => "idle",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum GuardError<E> {
    Cancelled,
    Timeout(TimeoutKind),
    Operation(E),
}

struct Deadlines {
    started: Option<Instant>,
    progress: Option<Instant>,
    disposed: bool,
}

struct Shared {
    deadlines: Mutex<Deadlines>,
    changed: Notify,
    cancellation: CancellationToken,
    policy: RequestPolicy,
}

/// Carries only small deadline state, never the provider body or model input.
#[derive(Clone)]
pub(super) struct RequestProgress {
    shared: Arc<Shared>,
}

impl RequestProgress {
    pub(super) fn cancellation(&self) -> CancellationToken {
        self.shared.cancellation.clone()
    }

    /// Carrier calls this at actual dispatch, after request-body admission.
    pub(super) fn start(&self) {
        let mut state = self.shared.deadlines.lock();
        if state.disposed || self.shared.cancellation.is_cancelled() || state.started.is_some() {
            return;
        }
        state.started = Some(Instant::now());
        drop(state);
        self.shared.changed.notify_one();
    }

    /// A new physical attempt waits for its own first output event.
    pub(super) fn await_first_response(&self) {
        let mut state = self.shared.deadlines.lock();
        if state.disposed {
            return;
        }
        state.progress = None;
        drop(state);
        self.shared.changed.notify_one();
    }

    /// One response event: `output` (model output) arms stall detection for
    /// this attempt; after that, every event resets the idle limit.
    pub(super) fn record_event(&self, output: bool) {
        let mut state = self.shared.deadlines.lock();
        if state.disposed
            || self.shared.cancellation.is_cancelled()
            || (!output && state.progress.is_none())
        {
            return;
        }
        let now = Instant::now();
        state.started.get_or_insert(now);
        state.progress = Some(now);
        drop(state);
        self.shared.changed.notify_one();
    }

    async fn deadline(&self) -> TimeoutKind {
        loop {
            let next = {
                let state = self.shared.deadlines.lock();
                state.started.map(|start| {
                    let total = start + self.shared.policy.total;
                    match (state.progress, self.shared.policy.idle) {
                        (None, _) => (total, TimeoutKind::FirstResponse),
                        (Some(progress), Some(idle)) if progress + idle < total => {
                            (progress + idle, TimeoutKind::Idle)
                        }
                        (Some(_), _) => (total, TimeoutKind::Total),
                    }
                })
            };
            if let Some((deadline, kind)) = next
                && Instant::now() >= deadline
            {
                return kind;
            }
            match next {
                Some((deadline, kind)) => tokio::select! {
                    biased;
                    () = self.shared.changed.notified() => {}
                    () = tokio::time::sleep_until(deadline) => return kind,
                },
                None => self.shared.changed.notified().await,
            }
        }
    }
}

struct RequestScope {
    progress: RequestProgress,
    settled: bool,
}

impl Drop for RequestScope {
    fn drop(&mut self) {
        self.progress.shared.deadlines.lock().disposed = true;
        if !self.settled {
            self.progress.shared.cancellation.cancel();
        }
    }
}

pub(super) async fn run_guarded<T, E, F, Operation>(
    external: CancellationToken,
    policy: RequestPolicy,
    operation: Operation,
) -> Result<T, GuardError<E>>
where
    F: Future<Output = Result<T, E>>,
    Operation: FnOnce(RequestProgress) -> F,
{
    let progress = RequestProgress {
        shared: Arc::new(Shared {
            deadlines: Mutex::new(Deadlines {
                started: None,
                progress: None,
                disposed: false,
            }),
            changed: Notify::new(),
            cancellation: external.child_token(),
            policy,
        }),
    };
    let mut scope = RequestScope {
        progress: progress.clone(),
        settled: false,
    };
    let operation = operation(progress.clone());
    tokio::pin!(operation);
    let result = tokio::select! {
        biased;
        () = external.cancelled() => Err(GuardError::Cancelled),
        kind = progress.deadline() => {
            progress.shared.cancellation.cancel();
            Err(GuardError::Timeout(kind))
        },
        result = &mut operation => result.map_err(GuardError::Operation),
    };
    scope.settled = true;
    // Source's catch checks the external abort before its timeout/error cause.
    if result.is_err() && external.is_cancelled() {
        Err(GuardError::Cancelled)
    } else {
        result
    }
}
