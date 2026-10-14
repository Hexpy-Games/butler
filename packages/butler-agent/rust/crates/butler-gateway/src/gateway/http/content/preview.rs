//! Root-mounted previews. Only a signed cookie selects a registered loopback port.
use super::{HttpError, HttpState, capability, refused};
use axum::{
    body::Body,
    http::{Request, StatusCode, header},
    response::Response,
};
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};

fn key(state: &HttpState) -> Result<String, HttpError> {
    state
        .security
        .token()
        .map(|token| format!("butler-preview-v1:{token}"))
        .ok_or_else(refused)
}
pub(in crate::gateway::http) fn url(
    state: &HttpState,
    origin: &str,
    id: &str,
) -> Result<String, HttpError> {
    if state.previews.target(id).is_none() {
        return Err(refused());
    }
    Ok(format!(
        "{origin}/__p/{}",
        capability::sign(&key(state)?, id, 0, super::now())
    ))
}
pub(super) async fn serve(
    state: Arc<HttpState>,
    mut request: Request<Body>,
) -> Result<Response, HttpError> {
    if let Some(cap) = request.uri().path().strip_prefix("/__p/") {
        return bootstrap(&state, &request, cap);
    }
    let cap =
        cookie(&request).ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let (id, _) = capability::verify(&key(&state)?, &cap, super::now()).ok_or_else(refused)?;
    let target = state.previews.target(&id).ok_or_else(refused)?;
    let websocket = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v == "websocket");
    if websocket
        || !matches!(
            *request.method(),
            axum::http::Method::GET | axum::http::Method::HEAD
        )
    {
        check_origin(&request)?;
    }
    let upgraded = websocket.then(|| hyper::upgrade::on(&mut request));
    let (parts, body) = request.into_parts();
    let path = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    let destination = format!("http://127.0.0.1:{}{path}", target.port);
    let mut headers = parts.headers;
    clean_headers(&mut headers, websocket);
    headers.remove(header::HOST);
    headers.remove(header::ORIGIN);
    if websocket {
        headers.insert(
            header::ORIGIN,
            header::HeaderValue::from_str(&format!("http://127.0.0.1:{}", target.port))
                .map_err(|_| refused())?,
        );
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| refused())?;
    let upstream = client
        .request(parts.method, destination)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|_| refused())?;
    reply(upstream, upgraded, target).await
}
fn bootstrap(state: &HttpState, request: &Request<Body>, cap: &str) -> Result<Response, HttpError> {
    if request.method() != axum::http::Method::GET {
        return Err(refused());
    }
    let (id, _) = capability::verify(&key(state)?, cap, super::now()).ok_or_else(refused)?;
    if state.previews.target(&id).is_none() {
        return Err(refused());
    }
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    response
        .headers_mut()
        .insert(header::LOCATION, header::HeaderValue::from_static("/"));
    response.headers_mut().insert(
        header::SET_COOKIE,
        header::HeaderValue::from_str(&format!(
            "butler_preview={cap}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600"
        ))
        .map_err(|_| refused())?,
    );
    Ok(response)
}
async fn reply(
    upstream: reqwest::Response,
    upgraded: Option<hyper::upgrade::OnUpgrade>,
    target: butler_runtime::previews::Target,
) -> Result<Response, HttpError> {
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    let websocket = status == StatusCode::SWITCHING_PROTOCOLS;
    clean_headers(&mut headers, websocket);
    headers.remove(header::SET_COOKIE);
    if let Some(upgraded) = upgraded {
        if !websocket {
            return Err(refused());
        }
        let mut server = upstream.upgrade().await.map_err(|_| refused())?;
        tokio::spawn(async move {
            if let Ok(client) = upgraded.await {
                let mut client = hyper_util::rt::TokioIo::new(client);
                tokio::select! {
                    _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {},
                    () = target.cancel.cancelled() => {},
                }
            }
        });
        let mut response = Response::new(Body::empty());
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        return Ok(response);
    }
    let mut response = Response::new(Body::from_stream(
        upstream
            .bytes_stream()
            .take_until(target.cancel.cancelled_owned()),
    ));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}
fn clean_headers(headers: &mut axum::http::HeaderMap, websocket: bool) {
    if !websocket {
        let named: Vec<_> = headers
            .get(header::CONNECTION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(',')
            .map(|s| s.trim().to_owned())
            .collect();
        for name in named {
            headers.remove(name);
        }
        headers.remove(header::CONNECTION);
        headers.remove(header::UPGRADE);
    }
    for name in [
        "authorization",
        "cookie",
        "proxy-authorization",
        "proxy-authenticate",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "forwarded",
    ] {
        headers.remove(name);
    }
    let forwarded: Vec<_> = headers
        .keys()
        .filter(|k| k.as_str().starts_with("x-forwarded-"))
        .cloned()
        .collect();
    for name in forwarded {
        headers.remove(name);
    }
}
fn cookie(request: &Request<Body>) -> Option<String> {
    let mut cookies = request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|v| v.trim().strip_prefix("butler_preview="));
    let first = cookies.next()?.to_owned();
    cookies.next().is_none().then_some(first)
}
fn check_origin(request: &Request<Body>) -> Result<(), HttpError> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| url::Url::parse(v).ok())
        .ok_or_else(refused)?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.host_str().is_none()
        || &origin[url::Position::BeforeHost..url::Position::AfterPort]
            != super::host(request.headers())?
    {
        return Err(refused());
    }
    Ok(())
}
pub(in crate::gateway::http) fn view(
    state: &HttpState,
    request: &Request<Body>,
) -> Result<Response, HttpError> {
    let id = request
        .uri()
        .path()
        .strip_prefix("/previews/")
        .and_then(|s| s.strip_suffix("/view"))
        .ok_or_else(refused)?;
    let origin = super::view_origin(state, request)?;
    super::super::json(
        StatusCode::OK,
        crate::gateway::protocol::ApiEnvelope {
            protocol_version: crate::gateway::protocol::APP_PROTOCOL_VERSION,
            data: serde_json::json!({"url":url(state,&origin,id)?,"revision":1,"revisions":[1]}),
        },
    )
}

pub(in crate::gateway::http) fn owner_id(
    state: &HttpState,
    session: &str,
    raw: &str,
) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let cap = url.path().strip_prefix("/__p/")?;
    let (id, _) = capability::verify(&key(state).ok()?, cap, super::now())?;
    state.previews.owned(session, &id).then_some(id)
}
