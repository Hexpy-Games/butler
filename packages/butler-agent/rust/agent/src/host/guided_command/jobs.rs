//! Bounded admission and close-drain for synchronous artifact work.

use parking_lot::Mutex;
use std::sync::Arc;

use tokio::sync::{Notify, Semaphore};

use crate::btcc::BtccError;

#[derive(Clone)]
pub(super) struct CommandJobs {
    inner: Arc<Inner>,
}
struct Inner {
    state: Mutex<State>,
    slots: Arc<Semaphore>,
    idle: Notify,
}
struct State {
    closing: bool,
    active: usize,
}
struct Active(Arc<Inner>);
impl Drop for Active {
    fn drop(&mut self) {
        let mut state = self.0.state.lock();
        state.active -= 1;
        drop(state);
        self.0.idle.notify_waiters();
    }
}

impl CommandJobs {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    closing: false,
                    active: 0,
                }),
                slots: Arc::new(Semaphore::new(2)),
                idle: Notify::new(),
            }),
        }
    }

    pub(super) async fn run<F, T>(&self, job: F) -> Result<T, BtccError>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let permit = Arc::clone(&self.inner.slots)
            .acquire_owned()
            .await
            .map_err(|_| error("command_jobs_closed"))?;
        {
            let mut state = self.inner.state.lock();
            if state.closing {
                return Err(error("command_jobs_closed"));
            }
            state.active = state.active.checked_add(1).expect("command jobs overflow");
        }
        let active = Active(Arc::clone(&self.inner));
        tokio::task::spawn_blocking(move || {
            let _active = active;
            let _permit = permit;
            job()
        })
        .await
        .map_err(|_| error("command_job_failed"))
    }

    pub(super) async fn close(&self) {
        {
            let mut state = self.inner.state.lock();
            state.closing = true;
            self.inner.slots.close();
        }
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.state.lock().active == 0 {
                return;
            }
            notified.await;
        }
    }
}
fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
