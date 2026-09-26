//! File-only App uploads, downloads, project originals, and outbound artifacts.

mod materialize;
mod names;
mod path;
mod snapshot;
#[cfg(test)]
mod tests;
mod upload;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use bytes::Bytes;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use super::{
    AppArtifactMaterializer, AppFileWrite, AppIdentityClock, AppMessageFileSnapshot,
    AppMessageFileStorage, ApplicationFuture, ArtifactMaterializationRequest,
    GatewayApplicationError, MaterializedResponderFile,
};

/// App SQLite remains with AppApplication; this owner holds only bounded file jobs.
pub(crate) struct NativeAppMessageFiles {
    root: PathBuf,
    clock: Arc<dyn AppIdentityClock>,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Arc<Mutex<bool>>,
}

impl NativeAppMessageFiles {
    pub(crate) fn new(data_root: PathBuf, clock: Arc<dyn AppIdentityClock>) -> Self {
        Self {
            root: data_root.join("app-server/message-files"),
            clock,
            permits: Arc::new(Semaphore::new(2)),
            jobs: TaskTracker::new(),
            closing: Arc::new(Mutex::new(false)),
        }
    }

    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        {
            let mut closing = self.closing.lock().expect("App files owner poisoned");
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }

    /// Persist one admitted project original using the same bounded file lane.
    /// AppApplication inserts the returned metadata in its existing SQLite owner.
    pub(crate) fn snapshot_source(
        &self,
        name: String,
        body: String,
    ) -> ApplicationFuture<MaterializedResponderFile> {
        self.run_file_job(move |root, clock| snapshot::write(root, clock, &name, &body))
    }

    fn run_file_job<T: Send + 'static>(
        &self,
        operation: impl FnOnce(
            &std::path::Path,
            &dyn AppIdentityClock,
        ) -> Result<T, GatewayApplicationError>
        + Send
        + 'static,
    ) -> ApplicationFuture<T> {
        let permits = Arc::clone(&self.permits);
        let jobs = self.jobs.clone();
        let root = self.root.clone();
        let clock = Arc::clone(&self.clock);
        let closing = Arc::clone(&self.closing);
        Box::pin(async move {
            let permit = permits
                .acquire_owned()
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            let (send, receive) = oneshot::channel();
            // Close and registration share a lock; caller cancellation cannot
            // detach file writes from the runtime's shutdown sequence.
            {
                let closing = closing.lock().expect("App files owner poisoned");
                if *closing {
                    return Err(GatewayApplicationError::Internal);
                }
                jobs.spawn(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        operation(&root, clock.as_ref())
                    })
                    .await
                    .map_err(|_| GatewayApplicationError::Internal)
                    .and_then(|result| result);
                    let _ = send.send(result);
                });
            }
            receive
                .await
                .map_err(|_| GatewayApplicationError::Internal)?
        })
    }
}

impl AppArtifactMaterializer for NativeAppMessageFiles {
    fn materialize(
        &self,
        request: ArtifactMaterializationRequest,
    ) -> ApplicationFuture<Vec<MaterializedResponderFile>> {
        self.run_file_job(move |root, clock| materialize::run(root, clock, request))
    }
}

impl AppMessageFileStorage for NativeAppMessageFiles {
    fn write_upload(&self, input: AppFileWrite) -> ApplicationFuture<MaterializedResponderFile> {
        self.run_file_job(move |root, clock| upload::write(root, clock, input))
    }

    fn prepare_uploaded(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<()> {
        self.run_file_job(move |root, _| upload::prepare(root, file))
    }

    fn read_original(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<Bytes> {
        self.run_file_job(move |root, _| upload::read(root, file))
    }
}
