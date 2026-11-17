//! Page-host reports for a conversation tab: download publication and terminal tab events.
use super::{HttpError, HttpState, error, pages};
use axum::{http::StatusCode, response::Response};
use butler_runtime::browser::{FILE_LIMIT, SESSION_LIMIT};
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
    let (link, user_held) = {
        let hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        hub.tabs
            .check(session, tab, "tab.selection")
            .map_err(|_| error(403, "not_your_tab"))?;
        (hub.pages.clone(), hub.tabs.is_user(tab))
    };
    if args["op"] == "failed" {
        return failed(link.as_deref(), session, tab, &args["reason"]);
    }
    if args["op"] == "popup_blocked" {
        return popup_blocked(link.as_deref(), user_held, session, tab, &args);
    }
    let context = context(&state, session).await?;
    if args["op"] == "prepare" {
        return super::super::json(StatusCode::OK, context);
    }
    if args["op"] != "publish" {
        return Err(error(400, "invalid_request"));
    }
    let (output, size) = publish(
        &state,
        session,
        &context,
        args["filename"].as_str().unwrap_or(""),
        args["turn_id"].as_str().unwrap_or(""),
        args["message_id"].as_str().unwrap_or(""),
    )
    .await?;
    if let Some(link) = link {
        // The publication succeeded, so the filename is the validated one.
        let mut event = json!({"path":format!("downloads/{}", args["filename"].as_str().unwrap_or("")),"size_bytes":size});
        if let (Some(target), Some(data)) = (event.as_object_mut(), output.as_object()) {
            target.extend(data.clone());
        }
        // A tab closed meanwhile has no one left to tell.
        let owner = format!("conversation:{session}");
        let _ = link
            .executor
            .tab_event(&owner, tab, "download_completed", &event);
    }
    super::super::json(StatusCode::OK, output)
}

/// The page host's terminal failure of a download: the event the executor
/// itself would queue for it.
fn failed(
    link: Option<&pages::Link>,
    session: &str,
    tab: &str,
    reason: &Value,
) -> Result<Response, HttpError> {
    let link = link.ok_or_else(|| error(409, "no_page_host"))?;
    let (kind, data) = match reason.as_str() {
        Some(r @ ("download_interrupted" | "download_storage_failed")) => {
            ("download_failed", json!({"reason":r}))
        }
        Some(
            r @ ("download_file_limit"
            | "download_session_limit"
            | "download_workspace_unavailable"
            | "download_cancelled"),
        ) => (
            "download_refused",
            json!({"reason":r,"file_limit_bytes":FILE_LIMIT,"session_limit_bytes":SESSION_LIMIT}),
        ),
        _ => return Err(error(400, "invalid_request")),
    };
    link.executor
        .tab_event(&format!("conversation:{session}"), tab, kind, &data)
        .map_err(|_| error(403, "not_your_tab"))?;
    super::super::json(StatusCode::OK, json!({"ok":true}))
}

/// The page host refused an Agent tab's pop-up: the event the executor itself
/// queues for it, with the opener's origin as `site`.
fn popup_blocked(
    link: Option<&pages::Link>,
    user_held: bool,
    session: &str,
    tab: &str,
    args: &Value,
) -> Result<Response, HttpError> {
    let link = link.ok_or_else(|| error(409, "no_page_host"))?;
    if user_held {
        return Err(error(403, "not_your_tab"));
    }
    let reason = match args["reason"].as_str() {
        Some(r @ ("popup_policy" | "tab_budget_exhausted")) => r,
        _ => return Err(error(400, "invalid_request")),
    };
    let invalid = || error(400, "invalid_request");
    let raw = args["url"].as_str().ok_or_else(invalid)?;
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    let web = matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none();
    if !web && raw != "about:blank" {
        return Err(invalid());
    }
    let site = args["site"].as_str().ok_or_else(invalid)?;
    let origin = url::Url::parse(site).map_err(|_| invalid())?.origin();
    if origin.ascii_serialization() != site {
        return Err(invalid());
    }
    let data = json!({"url":url.to_string(),"site":site,"reason":reason});
    link.executor
        .tab_event(
            &format!("conversation:{session}"),
            tab,
            "popup_blocked",
            &data,
        )
        .map_err(|_| error(403, "not_your_tab"))?;
    super::super::json(StatusCode::OK, json!({"ok":true}))
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
) -> Result<(Value, u64), HttpError> {
    let filename = Some(filename)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 240
                && !s.contains(['/', '\\'])
                && !s.chars().any(|c| c < '\u{20}')
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
    let file = workspace.join("downloads").join(filename);
    let request = PublishRequest {
        workspace,
        path: format!("downloads/{filename}"),
        entry: None,
        title: filename.chars().take(200).collect(),
        session_id: session.to_owned(),
        message_id: message_id.to_owned(),
        turn_id: turn_id.to_owned(),
    };
    let (output, size) = tokio::task::spawn_blocking(move || {
        let output = OutputStore::new(&data).publish(request)?.0;
        Ok((output, std::fs::metadata(file).map_or(0, |m| m.len())))
    })
    .await
    .map_err(|_| HttpError::Internal)?
    .map_err(|_: std::io::Error| error(400, "download_publication_failed"))?;
    if output.revisions.is_empty() {
        return Ok((json!({"skipped_files":output.skipped_files}), size));
    }
    state
        .application
        .browser_download_published(output.clone())
        .await?;
    Ok((
        json!({"output_id":output.output_id,
        "view":format!("/outputs/{}/view",output.output_id)}),
        size,
    ))
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
                .map(|(output, _)| output)
                .map_err(|_| "download_publication_failed".to_owned())
        })
    }
}
