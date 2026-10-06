//! Capability-only content origin: never dispatches an API route or authenticates cookies.
mod capability;
mod headers;
use super::{HttpError, HttpState, error::error_response};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode, header},
    response::Response,
    routing::any,
};
use butler_runtime::outputs::OutputStore;
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

pub(super) fn spawn(listener: TcpListener, state: Arc<HttpState>, closed: CancellationToken) {
    let router = Router::new().fallback(any(dispatch)).with_state(state);
    drop(tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(closed.cancelled_owned())
        .await
    }));
}
pub(super) fn port(state: &HttpState) -> u16 {
    state.remote.primary().port().saturating_add(1)
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
fn refused() -> HttpError {
    HttpError::public(403, "output_capability_refused", "Output link expired.")
}
fn store(state: &HttpState) -> Result<OutputStore, HttpError> {
    state
        .output_data
        .as_deref()
        .map(OutputStore::new)
        .ok_or_else(|| HttpError::public(503, "outputs_unavailable", "Outputs unavailable."))
}
fn host(headers: &axum::http::HeaderMap) -> Result<&str, HttpError> {
    let mut values = headers.get_all(header::HOST).iter();
    match (values.next(), values.next()) {
        (Some(value), None) => value.to_str().map_err(|_| refused()),
        _ => Err(refused()),
    }
}
fn content_host(state: &HttpState, value: &str) -> bool {
    let Ok(authority) = value.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    let name = authority.host().trim_matches(['[', ']']);
    let remote = state.remote.snapshot();
    remote
        .exposure
        .content_hosts
        .iter()
        .any(|h| h.eq_ignore_ascii_case(value))
        || (authority.port_u16() == Some(port(state))
            && (name == "localhost"
                || name
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
                || remote.lan_authorities.iter().any(|h| {
                    h.parse::<axum::http::uri::Authority>()
                        .is_ok_and(|a| a.host() == authority.host())
                })))
}
async fn dispatch(State(state): State<Arc<HttpState>>, request: Request<Body>) -> Response {
    let result = serve(&state, request).await;
    let mut response = result.unwrap_or_else(|e| error_response(&e));
    response.headers_mut().extend(headers::build(&state));
    response
}
async fn serve(state: &HttpState, request: Request<Body>) -> Result<Response, HttpError> {
    let (parts, _) = request.into_parts();
    if !content_host(state, host(&parts.headers)?) {
        return Err(refused());
    }
    if parts.method != Method::GET {
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    let path = parts
        .uri
        .path()
        .strip_prefix("/__o/")
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let (cap, path) = path.split_once('/').ok_or_else(refused)?;
    let token = state.security.token().ok_or_else(refused)?;
    let (id, revision) = capability::verify(&token, cap, now()).ok_or_else(refused)?;
    let decoded = decode_path(path)?;
    let outputs = store(state)?;
    let file = decoded.clone();
    let file = tokio::task::spawn_blocking(move || outputs.open_content(&id, revision, &file))
        .await
        .map_err(|_| refused())?
        .map_err(|_| refused())?;
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(mime(&decoded)),
    );
    Ok(response)
}
fn decode_path(path: &str) -> Result<String, HttpError> {
    // A URL parser performs percent decoding without treating '+' as a space.
    let decoded: String = url::form_urlencoded::parse(
        format!(
            "p={}",
            path.replace('+', "%2B")
                .replace('&', "%26")
                .replace('=', "%3D")
        )
        .as_bytes(),
    )
    .next()
    .map(|(_, v)| v.into_owned())
    .ok_or_else(refused)?;
    if decoded
        .split('/')
        .any(|p| p.is_empty() || p == "." || p == "..")
        || decoded.contains(['\\', '\0'])
    {
        return Err(refused());
    }
    Ok(decoded)
}
fn mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "webmanifest" => "application/manifest+json",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
pub(super) async fn view(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if request.method() != Method::GET {
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    let id = request
        .uri()
        .path()
        .strip_prefix("/outputs/")
        .and_then(|s| s.strip_suffix("/view"))
        .ok_or_else(refused)?
        .to_owned();
    let outputs = store(&state)?;
    let output = tokio::task::spawn_blocking(move || outputs.read(&id))
        .await
        .map_err(|_| refused())?
        .map_err(|_| refused())?;
    let selected = super::query(request.uri())
        .get("revision")
        .and_then(|s| s.parse::<u64>().ok());
    let rev = output
        .revisions
        .iter()
        .rev()
        .find(|r| selected.is_none_or(|v| v == r.revision))
        .ok_or_else(refused)?;
    let origin = view_origin(&state, &request)?;
    let token = state.security.token().ok_or_else(refused)?;
    let cap = capability::sign(&token, &output.output_id, rev.revision, now());
    let mut url = url::Url::parse(&format!("{origin}/__o/{cap}/")).map_err(|_| refused())?;
    url.path_segments_mut()
        .map_err(|()| refused())?
        .pop_if_empty()
        .extend(rev.entry.split('/'));
    super::json(
        StatusCode::OK,
        crate::gateway::protocol::ApiEnvelope {
            protocol_version: crate::gateway::protocol::APP_PROTOCOL_VERSION,
            data: serde_json::json!({"url":url.to_string(),"revision":rev.revision,"revisions":output.revisions.iter().map(|r|r.revision).collect::<Vec<_>>()}),
        },
    )
}

pub(super) fn admit_ui_frames(state: &HttpState, response: &mut Response) {
    let Some(policy) = response
        .headers()
        .get("content-security-policy")
        .and_then(|h| h.to_str().ok())
    else {
        return;
    };
    if policy != super::static_ui::CONTENT_SECURITY_POLICY {
        return;
    }
    let policy = format!("{policy}; {}", headers::ui_frames(state));
    if let Ok(value) = axum::http::HeaderValue::from_str(&policy) {
        response
            .headers_mut()
            .insert("content-security-policy", value);
    }
}

fn view_origin(state: &HttpState, request: &Request<Body>) -> Result<String, HttpError> {
    let authority = host(request.headers())?
        .parse::<axum::http::uri::Authority>()
        .map_err(|_| refused())?;
    let name = authority.host().trim_matches(['[', ']']);
    let remote = state.remote.snapshot();
    let forwarded = request.headers().contains_key("forwarded")
        || request
            .headers()
            .keys()
            .any(|h| h.as_str().starts_with("x-forwarded-"));
    let local = !forwarded
        && (name == "localhost"
            || name
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
            || remote.lan_authorities.iter().any(|h| {
                h.parse::<axum::http::uri::Authority>()
                    .is_ok_and(|a| a.host() == authority.host())
            }));
    let origin = if local {
        format!("http://{}:{}", authority.host(), port(state))
    } else {
        let content = remote.exposure.content_hosts.first().ok_or_else(|| {
            HttpError::public(409, "content_host_required", "Set a content host.")
        })?;
        if remote.exposure.allowed_hosts.iter().any(|h| h == content) {
            return Err(refused());
        }
        format!("https://{content}")
    };
    Ok(origin)
}
