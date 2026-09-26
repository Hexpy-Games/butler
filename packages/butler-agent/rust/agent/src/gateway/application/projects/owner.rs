//! A project create retains its folder, row and event lifetime after HTTP disconnect.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use super::{AppCreateProjectRequest, AppCreateProjectResult, folder, token};
use crate::gateway::{GatewayApplicationError, application::AppApplication};

#[derive(Clone)]
pub(in crate::gateway::application) struct ProjectCreationOwner(Arc<Inner>);

struct Inner {
    state: Mutex<State>,
    tasks: TaskTracker,
    permits: Arc<Semaphore>,
    secret: Option<String>,
}

struct State {
    closing: bool,
    workspace_root: PathBuf,
}

impl ProjectCreationOwner {
    pub(in crate::gateway::application) fn new(root: PathBuf, secret: Option<String>) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                closing: false,
                workspace_root: root,
            }),
            tasks: TaskTracker::new(),
            permits: Arc::new(Semaphore::new(2)),
            secret,
        }))
    }

    pub(in crate::gateway::application) fn workspace_root(&self) -> PathBuf {
        self.0
            .state
            .lock()
            .expect("App project owner poisoned")
            .workspace_root
            .clone()
    }

    pub(in crate::gateway::application) fn set_workspace_root(&self, root: PathBuf) {
        self.0
            .state
            .lock()
            .expect("App project owner poisoned")
            .workspace_root = root;
    }

    pub(in crate::gateway::application) fn resolve_workspace_selection(
        &self,
        selection: &str,
    ) -> Result<PathBuf, GatewayApplicationError> {
        let selected = token::selected_path(selection, self.0.secret.as_deref())?;
        folder::validate_existing(std::path::Path::new(&selected))
    }

    pub(in crate::gateway::application) async fn create(
        &self,
        application: AppApplication,
        request: AppCreateProjectRequest,
    ) -> Result<AppCreateProjectResult, GatewayApplicationError> {
        let permit = self
            .0
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
        let (send, receive) = oneshot::channel();
        {
            let state = self.0.state.lock().expect("App project owner poisoned");
            if state.closing {
                return Err(GatewayApplicationError::Internal);
            }
            let root = state.workspace_root.clone();
            let secret = self.0.secret.clone();
            self.0.tasks.spawn(async move {
                let _permit = permit;
                let result = application
                    .create_project_transaction(request, root, secret)
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
            let mut state = self.0.state.lock().expect("App project owner poisoned");
            state.closing = true;
            self.0.permits.close();
            self.0.tasks.close();
        }
        self.0.tasks.wait().await;
    }
}
