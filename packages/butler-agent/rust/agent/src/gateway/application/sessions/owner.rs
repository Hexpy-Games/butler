//! One App-owned lifetime for create-row, worktree provisioning and event publication.

use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{AppCreateSessionRequest, AppCreateSessionResult};
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::AppApplication;

#[derive(Clone)]
pub(in crate::gateway::application) struct SessionCreationOwner(Arc<Inner>);

struct Inner {
    closing: Mutex<bool>,
    tasks: TaskTracker,
    shutdown: CancellationToken,
}

impl SessionCreationOwner {
    pub(in crate::gateway::application) fn new() -> Self {
        Self(Arc::new(Inner {
            closing: Mutex::new(false),
            tasks: TaskTracker::new(),
            shutdown: CancellationToken::new(),
        }))
    }

    pub(super) async fn create(
        &self,
        application: AppApplication,
        request: AppCreateSessionRequest,
        server_shutdown: CancellationToken,
    ) -> Result<AppCreateSessionResult, GatewayApplicationError> {
        let (send, receive) = oneshot::channel();
        {
            let closing = self.0.closing.lock().expect("App session owner poisoned");
            if *closing {
                return Err(GatewayApplicationError::Internal);
            }
            let owner_shutdown = self.0.shutdown.clone();
            self.0.tasks.spawn(async move {
                let result = application
                    .create_session_transaction(request, server_shutdown, owner_shutdown)
                    .await;
                let _ = send.send(result);
            });
        }
        receive
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }

    pub(in crate::gateway::application) async fn close(&self) {
        {
            let mut closing = self.0.closing.lock().expect("App session owner poisoned");
            *closing = true;
            self.0.shutdown.cancel();
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }
}
