//! Closeable owner for explicitly requested project-briefing generations.

use parking_lot::Mutex;
use std::{collections::VecDeque, future::Future, sync::Arc};

use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BriefingState {
    Needed,
    Generating,
    Unavailable,
}

#[derive(Clone)]
pub(crate) struct ProjectDashboardBriefingOwner(Arc<Inner>);

struct Inner {
    state: Mutex<State>,
    tasks: TaskTracker,
}

struct State {
    closing: bool,
    next_id: u64,
    active: Option<Active>,
    attempted: VecDeque<String>,
}

struct Active {
    id: u64,
    revision: String,
    cancellation: CancellationToken,
}

impl ProjectDashboardBriefingOwner {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                closing: false,
                next_id: 0,
                active: None,
                attempted: VecDeque::new(),
            }),
            tasks: TaskTracker::new(),
        }))
    }

    pub(super) fn state(&self, revision: &str) -> BriefingState {
        let state = self.0.state.lock();
        if state.closing {
            return BriefingState::Unavailable;
        }
        if let Some(active) = &state.active {
            return if active.revision == revision {
                BriefingState::Generating
            } else {
                BriefingState::Unavailable
            };
        }
        if state.attempted.iter().any(|attempt| attempt == revision) {
            BriefingState::Unavailable
        } else {
            BriefingState::Needed
        }
    }

    pub(super) fn is_closing(&self) -> bool {
        self.0.state.lock().closing
    }

    pub(super) fn with_open<T>(&self, operation: impl FnOnce() -> T) -> Option<T> {
        let state = self.0.state.lock();
        (!state.closing).then(operation)
    }

    pub(super) fn start<F, Fut>(&self, revision: String, retry: bool, future: F) -> BriefingState
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (id, cancellation) = {
            let mut state = self.0.state.lock();
            if state.closing {
                return BriefingState::Unavailable;
            }
            if let Some(active) = &state.active {
                return if active.revision == revision {
                    BriefingState::Generating
                } else {
                    BriefingState::Unavailable
                };
            }
            if !retry && state.attempted.iter().any(|attempt| attempt == &revision) {
                return BriefingState::Unavailable;
            }
            if !state.attempted.iter().any(|attempt| attempt == &revision) {
                if state.attempted.len() >= 64 {
                    state.attempted.pop_front();
                }
                state.attempted.push_back(revision.clone());
            }
            state.next_id = state.next_id.saturating_add(1);
            let id = state.next_id;
            let cancellation = CancellationToken::new();
            state.active = Some(Active {
                id,
                revision,
                cancellation: cancellation.clone(),
            });
            (id, cancellation)
        };
        let owner = self.clone();
        self.0.tasks.spawn(async move {
            let future = future(cancellation.clone());
            tokio::select! {
                () = cancellation.cancelled() => {}
                () = future => {}
            }
            owner.finish(id);
        });
        BriefingState::Generating
    }

    pub(crate) async fn close(&self) {
        let cancellation = {
            let mut state = self.0.state.lock();
            state.closing = true;
            state.active.take().map(|active| active.cancellation)
        };
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
        self.0.tasks.close();
        self.0.tasks.wait().await;
    }

    fn finish(&self, id: u64) {
        let mut state = self.0.state.lock();
        if state.active.as_ref().is_some_and(|active| active.id == id) {
            state.active = None;
        }
    }
}
