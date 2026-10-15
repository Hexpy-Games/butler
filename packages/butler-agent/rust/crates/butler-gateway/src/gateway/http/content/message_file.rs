//! Explicit HTML previews use the content listener, never the authenticated origin.
use super::*;
use crate::gateway::MessageFileRef;

pub(in crate::gateway::http) fn is_html(file: &MessageFileRef) -> bool {
    let name = file.safe_name.to_ascii_lowercase();
    name.ends_with(".html") || name.ends_with(".htm") || file.mime_type == "text/html"
}

pub(in crate::gateway::http) fn view(
    state: &HttpState,
    request: &Request<Body>,
    file: &MessageFileRef,
) -> Result<Response, HttpError> {
    let id = &file.file_id;
    if !is_html(file) {
        return Err(refused());
    }
    let origin = view_origin(state, request)?;
    let token = state.security.token().ok_or_else(refused)?;
    let issued = now();
    let cap = capability::sign(&token, &format!("message-file-{id}"), 0, issued);
    super::super::json(
        StatusCode::OK,
        crate::gateway::protocol::ApiEnvelope {
            protocol_version: crate::gateway::protocol::APP_PROTOCOL_VERSION,
            data: serde_json::json!({"url": format!("{origin}/__o/{cap}/index.html"), "expires_at": issued + capability::TTL_SECONDS}),
        },
    )
}

#[derive(Clone)]
pub(super) struct Preview;

pub(super) async fn serve(
    state: &HttpState,
    id: &str,
    revision: u64,
    path: &str,
) -> Result<Response, HttpError> {
    if revision != 0 || path != "index.html" {
        return Err(refused());
    }
    let download = state
        .application
        .download_message_file(id.to_owned())
        .await?;
    if !is_html(&download.file) {
        return Err(refused());
    }
    let mut response = Response::new(Body::from(download.bytes));
    response.extensions_mut().insert(Preview);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/html; charset=utf-8"),
    );
    Ok(response)
}
