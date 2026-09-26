use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Notify, Semaphore};

use super::discovery::{WorkspaceListInput, WorkspaceListOutcome, list_blocking};
use super::files::{ReadFileInput, WorkspaceFileRead, read_one_blocking};
use super::grep::{GrepCandidate, GrepRead, read_candidate};
use super::path_guard::{GuardInput, GuardResult, resolve_workspace_path_guard};

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(crate) struct NativeWorkspaceFiles {
    inner: Arc<FileOwner>,
}
struct FileOwner {
    permits: Arc<Semaphore>,
    state: Mutex<OwnerState>,
    idle: Notify,
}
struct OwnerState {
    closing: bool,
    active: usize,
}
struct ActiveOperation(Arc<FileOwner>);
impl Drop for ActiveOperation {
    fn drop(&mut self) {
        let mut state = self.0.state.lock();
        state.active -= 1;
        drop(state);
        self.0.idle.notify_waiters();
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FileOwnerError {
    pub code: &'static str,
}

impl NativeWorkspaceFiles {
    pub(crate) fn new(max_blocking_reads: usize) -> Self {
        Self {
            inner: Arc::new(FileOwner {
                permits: Arc::new(Semaphore::new(max_blocking_reads.max(1))),
                state: Mutex::new(OwnerState {
                    closing: false,
                    active: 0,
                }),
                idle: Notify::new(),
            }),
        }
    }
    pub(crate) fn active_count(&self) -> usize {
        self.inner.state.lock().active
    }
    pub(crate) async fn close(&self) {
        {
            self.inner.state.lock().closing = true;
        }
        self.inner.permits.close();
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
    pub(super) async fn run<T: Send + 'static>(
        &self,
        action: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, FileOwnerError> {
        let permit = self
            .inner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| FileOwnerError {
                code: "workspace_files_closed",
            })?;
        {
            let mut state = self.inner.state.lock();
            if state.closing {
                return Err(FileOwnerError {
                    code: "workspace_files_closed",
                });
            }
            state.active += 1;
        }
        let active = ActiveOperation(Arc::clone(&self.inner));
        let task = tokio::task::spawn_blocking(move || {
            let _active = active;
            let _permit = permit;
            action()
        });
        task.await.map_err(|_| FileOwnerError {
            code: "workspace_file_worker_failed",
        })
    }
    pub(crate) async fn guard(
        &self,
        root: PathBuf,
        path: String,
        relative_only: bool,
        protected_roots: Vec<PathBuf>,
    ) -> Result<std::io::Result<GuardResult>, FileOwnerError> {
        self.run(move || {
            resolve_workspace_path_guard(GuardInput {
                root: &root,
                requested: &path,
                relative_only,
                allow_directories: false,
                protected_roots: &protected_roots,
            })
        })
        .await
    }
    pub(crate) async fn read_one(
        &self,
        input: ReadFileInput,
    ) -> Result<std::io::Result<WorkspaceFileRead>, FileOwnerError> {
        self.run(move || read_one_blocking(&input)).await
    }

    pub(crate) async fn list_files(
        &self,
        input: WorkspaceListInput,
    ) -> Result<std::io::Result<WorkspaceListOutcome>, FileOwnerError> {
        self.run(move || list_blocking(&input)).await
    }

    pub(crate) async fn grep_candidate(
        &self,
        input: GrepCandidate,
    ) -> Result<GrepRead, FileOwnerError> {
        self.run(move || read_candidate(&input)).await
    }
}
