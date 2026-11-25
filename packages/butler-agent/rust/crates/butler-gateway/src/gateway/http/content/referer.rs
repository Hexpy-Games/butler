//! Root-absolute requests from a capability page resolve under that page's capability.
use super::{HttpError, HttpState, capability, decode_path, now, port, preview};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    response::Response,
};

pub(super) fn redirect(
    state: &HttpState,
    request: &Request<Body>,
) -> Option<Result<Response, HttpError>> {
    let path = request.uri().path();
    if request.method() != Method::GET || path.starts_with("/__p/") || preview::has_cookie(request)
    {
        return None;
    }
    let cap = referer_cap(request.headers())?;
    let token = state.security.token()?;
    let port = port(state)?;
    capability::verify(&token, port, &cap, now())?;
    let missing = || HttpError::public(404, "not_found", "Route not found.");
    if decode_path(path.strip_prefix('/').unwrap_or(path)).is_err() {
        return Some(Err(missing()));
    }
    let mut location = format!("/__o/{cap}{path}");
    if let Some(query) = request.uri().query() {
        location.push('?');
        location.push_str(query);
    }
    let Ok(location) = HeaderValue::from_str(&location) else {
        return Some(Err(missing()));
    };
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::TEMPORARY_REDIRECT;
    response.headers_mut().insert(header::LOCATION, location);
    Some(Ok(response))
}

fn referer_cap(headers: &HeaderMap) -> Option<String> {
    let mut values = headers.get_all(header::REFERER).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    let url;
    let path = if value.starts_with('/') {
        value.split(['?', '#']).next()?
    } else {
        url = url::Url::parse(value).ok()?;
        url.path()
    };
    let cap = path.strip_prefix("/__o/")?.split_once('/')?.0;
    (!cap.is_empty()).then(|| cap.to_owned())
}
