//! Resolve signed views on the main and read their contents over the remote socket.
use super::{
    HttpError, HttpState, OUTPUT_CHUNK, capability, decode_path, message_file, mime, now, port,
    refused, signed_view, view_origin,
};
use crate::gateway::{
    http::{json, query, remote_sessions::link},
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
    remote_computers::{self, Link},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{StreamExt, stream};
use serde_json::Value;

pub(in crate::gateway::http) async fn output_view(
    state: &HttpState,
    headers: HeaderMap,
    uri: Uri,
    computer: String,
) -> Result<Response, HttpError> {
    let id = uri
        .path()
        .strip_prefix("/outputs/")
        .and_then(|p| p.strip_suffix("/view"))
        .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| HttpError::public(404, "output_not_found", "Output not found."))?;
    let mut path = format!("/outputs/{id}/content");
    if let Some(revision) = query(&uri)
        .get("revision")
        .and_then(|v| v.parse::<u64>().ok())
    {
        use std::fmt::Write;
        write!(path, "?revision={revision}").map_err(|_| HttpError::Internal)?;
    }
    let reply =
        remote_computers::forward(&link(state)?, &computer, "GET", &path, Vec::new()).await?;
    let data = remote_computers::data(reply)?;
    let revision = data["revision"].as_u64().ok_or_else(refused)?;
    let entry = data["entry"].as_str().ok_or_else(refused)?;
    let revisions = data["revisions"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .map(Value::as_u64)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(refused)?;
    signed_view(
        state,
        &headers,
        &format!("remote.{computer}.{id}"),
        revision,
        entry,
        revisions,
    )
}

pub(in crate::gateway::http) fn message_file_view(
    state: &HttpState,
    headers: &HeaderMap,
    uri: &Uri,
    computer: &str,
) -> Result<Response, HttpError> {
    let id = uri
        .path()
        .strip_prefix("/message-files/")
        .and_then(|p| p.strip_suffix("/view"))
        .filter(|id| {
            id.len() == 41
                && id.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("file-"))
                && id[5..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        })
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let origin = view_origin(state, headers)?;
    let token = state.security.token().ok_or_else(refused)?;
    let issued = now();
    let cap = capability::sign(
        &token,
        port(state),
        &format!("remote.{computer}.message-file-{id}"),
        0,
        issued,
    );
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: serde_json::json!({"url":format!("{origin}/__o/{cap}/index.html"), "expires_at":issued + capability::TTL_SECONDS}),
        },
    )
}

async fn chunk(
    link: &Link,
    computer: &str,
    output: &str,
    revision: u64,
    path: &str,
    offset: u64,
) -> Result<Vec<u8>, HttpError> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", path)
        .finish();
    let path = format!("/outputs/{output}/content?revision={revision}&{query}&offset={offset}");
    let reply = remote_computers::forward(link, computer, "GET", &path, Vec::new())
        .await
        .map_err(|_| refused())?;
    if reply.status != 200 {
        return Err(refused());
    }
    STANDARD
        .decode(reply.bytes.unwrap_or_default())
        .map_err(|_| refused())
}

pub(super) async fn serve(
    state: &HttpState,
    rest: &str,
    revision: u64,
    path: &str,
) -> Result<Response, HttpError> {
    let (computer, object) = rest.split_once('.').ok_or_else(refused)?;
    if let Some(id) = object.strip_prefix("message-file-") {
        if revision != 0 || path != "index.html" {
            return Err(refused());
        }
        let reply = remote_computers::forward(
            &link(state)?,
            computer,
            "GET",
            &format!("/message-files/{id}"),
            Vec::new(),
        )
        .await?;
        if reply.status != 200
            || !reply
                .headers
                .get("content-type")
                .is_some_and(|v| v.starts_with("text/html"))
        {
            return Err(refused());
        }
        let bytes = STANDARD
            .decode(reply.bytes.unwrap_or_default())
            .map_err(|_| HttpError::Internal)?;
        let mut response = Response::new(Body::from(bytes));
        response.extensions_mut().insert(message_file::Preview);
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        return Ok(response);
    }
    let decoded = decode_path(path)?;
    let link = link(state).map_err(|_| refused())?;
    let first = chunk(&link, computer, object, revision, &decoded, 0).await?;
    let content_type = mime(&decoded);
    let length = first.len() as u64;
    let next = (
        link,
        computer.to_owned(),
        object.to_owned(),
        revision,
        decoded,
        length,
        length < OUTPUT_CHUNK,
    );
    let remaining = stream::try_unfold(
        next,
        |(link, computer, output, revision, path, offset, done)| async move {
            if done {
                return Ok(None);
            }
            let bytes = chunk(&link, &computer, &output, revision, &path, offset)
                .await
                .map_err(|_| std::io::Error::other("remote_output_chunk"))?;
            let length = bytes.len() as u64;
            let next = (
                link,
                computer,
                output,
                revision,
                path,
                offset + length,
                length < OUTPUT_CHUNK,
            );
            Ok(Some((bytes, next)))
        },
    );
    let stream = stream::once(async move { Ok::<_, std::io::Error>(first) }).chain(remaining);
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from_stream(stream))
        .map_err(|_| HttpError::Internal)
}
