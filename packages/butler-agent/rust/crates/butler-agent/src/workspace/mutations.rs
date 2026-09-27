//! One process-owned admission and serialization lane for file mutations.

mod contracts;
mod diff;
mod edit;
mod failure;
mod guard;
mod io;
mod write;

#[cfg(test)]
mod tests;

pub(crate) use contracts::{
    BatchResult, ChangedFile, CommitObserver, CommittedFile, EditFailure, EditMutation, EditedFile,
    ExactEdit, MutationCommand, MutationContext, MutationOutcome, Unobserved, WriteMutation,
};

pub(crate) fn net_changed_file_detail(
    path: &str,
    before: &[u8],
    after: &[u8],
) -> Option<ChangedFile> {
    diff::changed_file(path, before, after, false)
}

pub(crate) use edit::prepare_exact_text;

use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Notify, Semaphore, oneshot};

use contracts::GuardedCommand;

type MutationCompletion = Result<(MutationOutcome, Duration), MutationOwnerError>;

#[derive(Clone)]
pub(crate) struct WorkspaceMutations {
    inner: Arc<MutationOwner>,
}

struct MutationOwner {
    state: Mutex<OwnerState>,
    serial: Arc<Semaphore>,
    idle: Notify,
    observer: Arc<dyn CommitObserver>,
}

struct OwnerState {
    closing: bool,
    active: usize,
}

struct Active(Arc<MutationOwner>);

impl Drop for Active {
    fn drop(&mut self) {
        let mut state = self.0.state.lock();
        state.active -= 1;
        drop(state);
        self.0.idle.notify_waiters();
    }
}

/// Failures of the serial workspace mutation owner.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MutationOwnerError {
    /// The owner is closing, so no new mutation is admitted.
    #[error("workspace_mutations_closed")]
    Closed,
    /// Preparing the mutation's path guard failed with an I/O error.
    #[error("workspace_mutation_guard_io")]
    GuardIo(#[source] std::io::Error),
    /// The blocking mutation task panicked or was cancelled.
    #[error("workspace_mutation_worker_failed")]
    WorkerFailed(#[source] tokio::task::JoinError),
}

impl MutationOwnerError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Closed => "workspace_mutations_closed",
            Self::GuardIo(_) => "workspace_mutation_guard_io",
            Self::WorkerFailed(_) => "workspace_mutation_worker_failed",
        }
    }
}

impl WorkspaceMutations {
    pub(crate) fn new() -> Self {
        Self::observed(Arc::new(Unobserved))
    }

    pub(crate) fn observed(observer: Arc<dyn CommitObserver>) -> Self {
        Self {
            inner: Arc::new(MutationOwner {
                state: Mutex::new(OwnerState {
                    closing: false,
                    active: 0,
                }),
                serial: Arc::new(Semaphore::new(1)),
                idle: Notify::new(),
                observer,
            }),
        }
    }

    /// Registers the owned command synchronously; caller cancellation cannot undo admission.
    pub(crate) fn submit(
        &self,
        command: MutationCommand,
    ) -> Result<oneshot::Receiver<MutationCompletion>, MutationOwnerError> {
        {
            let mut state = self.inner.state.lock();
            if state.closing {
                return Err(MutationOwnerError::Closed);
            }
            state.active += 1;
        }
        let active = Active(Arc::clone(&self.inner));
        let serial = Arc::clone(&self.inner.serial);
        let observer = Arc::clone(&self.inner.observer);
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _active = active;
            let prepared = tokio::task::spawn_blocking(move || guard::prepare(command)).await;
            let result = match prepared {
                Ok(Ok(Err(outcome))) => Ok((outcome, Duration::ZERO)),
                Ok(Ok(Ok(command))) => {
                    let started = Instant::now();
                    execute_serial(command, serial, observer)
                        .await
                        .map(|outcome| (outcome, started.elapsed()))
                }
                Ok(Err(error)) => Err(MutationOwnerError::GuardIo(error)),
                Err(error) => Err(MutationOwnerError::WorkerFailed(error)),
            };
            let _ignored_cancelled_caller = sender.send(result);
        });
        Ok(receiver)
    }

    pub(crate) fn active_count(&self) -> usize {
        self.inner.state.lock().active
    }

    pub(crate) async fn close(&self) {
        self.inner.state.lock().closing = true;
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active_count() == 0 {
                break;
            }
            notified.await;
        }
    }
}

async fn execute_serial(
    command: GuardedCommand,
    serial: Arc<Semaphore>,
    observer: Arc<dyn CommitObserver>,
) -> Result<MutationOutcome, MutationOwnerError> {
    let permit = serial
        .acquire_owned()
        .await
        // The serial semaphore is never closed; AcquireError carries no cause.
        .map_err(|_closed| MutationOwnerError::Closed)?;
    tokio::task::spawn_blocking(move || {
        let _lease = permit;
        match command {
            GuardedCommand::Write(input, path) => {
                MutationOutcome::Write(write::execute(input, path, observer.as_ref()))
            }
            GuardedCommand::Edit(input, paths) => edit::execute(&input, paths, observer.as_ref()),
        }
    })
    .await
    .map_err(MutationOwnerError::WorkerFailed)
}
