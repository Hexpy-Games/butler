//! Main-only download publication: canonical session workspace, no caller roots.
use super::{HttpError, HttpState, error};
use axum::{http::StatusCode, response::Response};
use butler_runtime::outputs::{OutputStore, PublishRequest};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

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
    let context = context(&state, session).await?;
    if args["op"] == "prepare" {
        return super::super::json(StatusCode::OK, context);
    }
    if args["op"] != "publish" {
        return Err(error(400, "invalid_request"));
    }
    let output = publish(
        &state,
        session,
        &context,
        args["filename"].as_str().unwrap_or(""),
        args["turn_id"].as_str().unwrap_or(""),
        args["message_id"].as_str().unwrap_or(""),
    )
    .await?;
    super::super::json(StatusCode::OK, output)
}

async fn context(state: &HttpState, session: &str) -> Result<Value, HttpError> {
    Ok(state
        .application
        .browser_download_context(session.to_owned())
        .await?)
}

/// Publishes `<workspace>/downloads/<filename>` as a session output.
async fn publish(
    state: &HttpState,
    session: &str,
    context: &Value,
    filename: &str,
    turn_id: &str,
    message_id: &str,
) -> Result<Value, HttpError> {
    let filename = Some(filename)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 240
                && !s.contains(['/', '\\', '\0'])
                && *s != "."
                && *s != ".."
        })
        .ok_or_else(|| error(400, "invalid_download_path"))?;
    let workspace = PathBuf::from(
        context["workspace_path"]
            .as_str()
            .ok_or(HttpError::Internal)?,
    );
    let data = state
        .output_data
        .clone()
        .ok_or_else(|| error(503, "outputs_unavailable"))?;
    let request = PublishRequest {
        workspace,
        path: format!("downloads/{filename}"),
        entry: None,
        title: filename.chars().take(200).collect(),
        session_id: session.to_owned(),
        message_id: message_id.to_owned(),
        turn_id: turn_id.to_owned(),
    };
    let output = tokio::task::spawn_blocking(move || OutputStore::new(&data).publish(request))
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|_| error(400, "download_publication_failed"))?
        .0;
    state
        .application
        .browser_download_published(output.clone())
        .await?;
    Ok(json!({"output_id":output.output_id,
        "view":format!("/outputs/{}/view",output.output_id)}))
}

/// The headless browser's download side: the same workspace and publication.
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

    fn publish(
        &self,
        session: String,
        filename: String,
        turn_id: String,
        message_id: String,
    ) -> butler_runtime::browser::PortFuture {
        let state = self.0.clone();
        Box::pin(async move {
            let state = state.upgrade().ok_or("gateway_closed")?;
            let context = context(&state, &session)
                .await
                .map_err(|_| "download_workspace_unavailable".to_owned())?;
            publish(&state, &session, &context, &filename, &turn_id, &message_id)
                .await
                .map_err(|_| "download_publication_failed".to_owned())
        })
    }
}
