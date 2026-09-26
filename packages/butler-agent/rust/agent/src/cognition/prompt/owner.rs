use parking_lot::Mutex;
use std::sync::Arc;

use tokio::sync::{Notify, Semaphore};

use crate::cognition::{CognitionError, CognitionResult};

#[derive(Clone)]
pub(super) struct PromptReadOwner {
    inner: Arc<Owner>,
}

struct Owner {
    permits: Arc<Semaphore>,
    state: Mutex<State>,
    idle: Notify,
}

struct State {
    closing: bool,
    active: usize,
}

struct Active(Arc<Owner>);

impl Drop for Active {
    fn drop(&mut self) {
        let mut state = self.0.state.lock();
        state.active -= 1;
        drop(state);
        self.0.idle.notify_waiters();
    }
}

impl PromptReadOwner {
    pub(super) fn new(max_blocking_reads: usize) -> Self {
        Self {
            inner: Arc::new(Owner {
                permits: Arc::new(Semaphore::new(max_blocking_reads.max(1))),
                state: Mutex::new(State {
                    closing: false,
                    active: 0,
                }),
                idle: Notify::new(),
            }),
        }
    }

    pub(super) async fn run<T: Send + 'static>(
        &self,
        action: impl FnOnce() -> CognitionResult<T> + Send + 'static,
    ) -> CognitionResult<T> {
        let permit = self
            .inner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                CognitionError::new(
                    "cognition_prompt_closed",
                    "cognition prompt reader is closed",
                )
            })?;
        {
            let mut state = self.inner.state.lock();
            if state.closing {
                return Err(CognitionError::new(
                    "cognition_prompt_closed",
                    "cognition prompt reader is closed",
                ));
            }
            state.active += 1;
        }
        let active = Active(self.inner.clone());
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _active = active;
            action()
        })
        .await
        .map_err(|_| {
            CognitionError::new(
                "cognition_prompt_worker_failed",
                "cognition prompt read worker failed",
            )
        })?
    }

    pub(super) async fn close(&self) {
        {
            let mut state = self.inner.state.lock();
            state.closing = true;
        }
        self.inner.permits.close();
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.state.lock().active == 0 {
                break;
            }
            notified.await;
        }
    }
}
