use std::sync::{Arc, Mutex};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{AppSessionBranchResult, AppStartTopicConversationRequest};
use crate::gateway::{GatewayApplicationError, application::AppApplication};

#[derive(Clone)]
pub(in crate::gateway::application) struct SessionBranchOwner(Arc<Inner>);

struct Inner {
    closing: Mutex<bool>,
    permit: Arc<Semaphore>,
    tasks: TaskTracker,
    shutdown: CancellationToken,
}

impl SessionBranchOwner {
    pub(in crate::gateway::application) fn new() -> Self {
        Self(Arc::new(Inner {
            closing: Mutex::new(false),
            permit: Arc::new(Semaphore::new(1)),
            tasks: TaskTracker::new(),
            shutdown: CancellationToken::new(),
        }))
    }

    pub(super) async fn start(
        &self,
        application: AppApplication,
        request: AppStartTopicConversationRequest,
        server_shutdown: CancellationToken,
    ) -> Result<AppSessionBranchResult, GatewayApplicationError> {
        let permit = self
            .0
            .permit
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
        let (send, receive) = oneshot::channel();
        {
            let closing = self.0.closing.lock().expect("App branch owner poisoned");
            if *closing {
                return Err(GatewayApplicationError::Internal);
            }
            let owner_shutdown = self.0.shutdown.clone();
            self.0.tasks.spawn(async move {
                let _permit = permit;
                let result = application
                    .run_session_branch(request, server_shutdown, owner_shutdown)
                    .await;
                let _cancelled_waiter = send.send(result);
            });
        }
        receive
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }

    pub(in crate::gateway::application) async fn close(&self) {
        {
            let mut closing = self.0.closing.lock().expect("App branch owner poisoned");
            *closing = true;
            self.0.permit.close();
            self.0.shutdown.cancel();
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }
}
