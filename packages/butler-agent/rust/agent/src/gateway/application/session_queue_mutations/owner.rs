//! Tracks admitted queue mutations through HTTP disconnect and shutdown drain.

use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use crate::gateway::{ApplicationFuture, GatewayApplicationError};

#[derive(Clone)]
pub(in crate::gateway::application) struct SessionQueueMutationOwner(Arc<Inner>);

struct Inner {
    closing: Mutex<bool>,
    tasks: TaskTracker,
}

impl SessionQueueMutationOwner {
    pub(in crate::gateway::application) fn new() -> Self {
        Self(Arc::new(Inner {
            closing: Mutex::new(false),
            tasks: TaskTracker::new(),
        }))
    }

    pub(super) async fn run<T: Send + 'static>(
        &self,
        operation: ApplicationFuture<T>,
    ) -> Result<T, GatewayApplicationError> {
        let (send, receive) = oneshot::channel();
        {
            let closing = self.0.closing.lock().expect("App queue owner poisoned");
            if *closing {
                return Err(GatewayApplicationError::Internal);
            }
            self.0.tasks.spawn(async move {
                let _ = send.send(operation.await);
            });
        }
        receive
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }

    pub(in crate::gateway::application) async fn close(&self) {
        {
            let mut closing = self.0.closing.lock().expect("App queue owner poisoned");
            *closing = true;
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }
}
