//! Main-only download workspace: canonical session workspace, no caller roots.
use super::{HttpError, HttpState, error};
use axum::{http::StatusCode, response::Response};
use serde_json::Value;
use std::sync::Arc;

pub(super) async fn handle(state: Arc<HttpState>, args: Value) -> Result<Response, HttpError> {
    let session = args["session"]
        .as_str()
        .ok_or_else(|| error(400, "invalid_request"))?;
    let tab = args["tab"]
        .as_str()
        .ok_or_else(|| error(400, "invalid_request"))?;
    state
        .browser
        .0
        .lock()
        .map_err(|_| HttpError::Internal)?
        .tabs
        .check(session, tab, "tab.selection")
        .map_err(|_| error(403, "not_your_tab"))?;
    if args["op"] != "prepare" {
        return Err(error(400, "invalid_request"));
    }
    super::super::json(StatusCode::OK, context(&state, session).await?)
}

async fn context(state: &HttpState, session: &str) -> Result<Value, HttpError> {
    Ok(state
        .application
        .browser_download_context(session.to_owned())
        .await?)
}

/// The headless browser's download side uses the same workspace.
pub(in crate::gateway::http) struct HeadlessDownloads(pub std::sync::Weak<HttpState>);

impl butler_runtime::browser::DownloadPort for HeadlessDownloads {
    fn prepare(&self, session: String) -> butler_runtime::browser::PortFuture {
        let state = self.0.clone();
        Box::pin(async move {
            let state = state.upgrade().ok_or("gateway_closed")?;
            context(&state, &session)
                .await
                .map_err(|_| "download_workspace_unavailable".to_owned())
        })
    }
}
