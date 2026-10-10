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
    let context = state
        .application
        .browser_download_context(session.to_owned())
        .await?;
    if args["op"] == "prepare" {
        return super::super::json(StatusCode::OK, context);
    }
    if args["op"] != "publish" {
        return Err(error(400, "invalid_request"));
    }
    let filename = args["filename"]
        .as_str()
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
        message_id: args["message_id"].as_str().unwrap_or("").to_owned(),
        turn_id: args["turn_id"].as_str().unwrap_or("").to_owned(),
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
    super::super::json(
        StatusCode::OK,
        json!({"output_id":output.output_id,
        "view":format!("/outputs/{}/view",output.output_id)}),
    )
}
