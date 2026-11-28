//! Requests from Butler's own process use the same API router as the listeners.
use std::sync::Arc;

use axum::{
    Extension, Router,
    body::{Body, Bytes},
    extract::DefaultBodyLimit,
    http::{HeaderMap, Method, Request, header::CONTENT_LENGTH},
    response::Response,
};
use tokio_util::{
    sync::CancellationToken,
    task::{AbortOnDropHandle, TaskTracker},
};
use tower::ServiceExt;

use super::{
    HttpState, MAX_REQUEST_BODY_SIZE,
    listeners::{InProcessPeer, ListenerScope},
};

#[derive(Clone)]
pub struct InProcessGateway {
    router: Router,
    shutdown: CancellationToken,
    tracker: TaskTracker,
}

#[derive(Debug, thiserror::Error)]
pub enum InProcessError {
    #[error("gateway_stopped")]
    GatewayStopped,
    #[error("invalid in-process request")]
    InvalidRequest(#[from] axum::http::Error),
    #[error("in-process request task failed")]
    Join(#[from] tokio::task::JoinError),
}

impl InProcessGateway {
    pub(in crate::gateway) fn new(state: Arc<HttpState>, shutdown: CancellationToken) -> Self {
        let router = super::router::routes()
            .with_state(state)
            .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_SIZE))
            .layer(Extension(ListenerScope {
                closed: shutdown.clone(),
            }))
            .layer(Extension(InProcessPeer));
        Self {
            router,
            shutdown,
            tracker: TaskTracker::new(),
        }
    }

    pub async fn request(
        &self,
        method: Method,
        path_and_query: &str,
        headers: HeaderMap,
        body: Bytes,
    ) -> Result<Response, InProcessError> {
        // Register before checking shutdown so drain sees every admitted request.
        let admission = self.tracker.token();
        if self.shutdown.is_cancelled() {
            return Err(InProcessError::GatewayStopped);
        }
        let length = body.len();
        let mut request = Request::builder()
            .method(method)
            .uri(path_and_query)
            .body(Body::from(body))?;
        *request.headers_mut() = headers;
        request.headers_mut().insert(CONTENT_LENGTH, length.into());
        let router = self.router.clone();
        // Own task for a fresh stack; aborted when the caller drops, like a closed connection.
        let task = AbortOnDropHandle::new(self.tracker.spawn(async move {
            let Ok(response) = router.oneshot(request).await;
            response
        }));
        drop(admission);
        Ok(task.await?)
    }

    pub(super) async fn drain(&self) {
        self.tracker.close();
        self.tracker.wait().await;
    }
}
