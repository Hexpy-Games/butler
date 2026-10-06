use super::super::HttpState;
use axum::http::{HeaderMap, HeaderValue};

pub(super) fn build(state: &HttpState) -> HeaderMap {
    let remote = state.remote.snapshot();
    let mut ancestors = vec!["app://butler".to_owned()];
    for host in std::iter::once(state.remote.primary().to_string())
        .chain([format!("localhost:{}", state.remote.primary().port())])
        .chain(remote.lan_authorities)
        .chain(remote.exposure.allowed_hosts)
    {
        let Ok(host) = crate::gateway::normalize_allowed_host(&host) else {
            continue;
        };
        ancestors.extend([format!("http://{host}"), format!("https://{host}")]);
    }
    let csp = format!(
        "frame-ancestors {}; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'",
        ancestors.join(" ")
    );
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&csp) {
        headers.insert("content-security-policy", value);
    }
    for (name, value) in [
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("cross-origin-opener-policy", "same-origin"),
        ("cache-control", "no-store"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    headers
}

/// The UI document must admit its separate output origin, never an API frame.
pub(super) fn ui_frames(state: &HttpState) -> String {
    let remote = state.remote.snapshot();
    let port = super::port(state);
    let mut origins = vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        format!("http://[::1]:{port}"),
    ];
    for host in remote.lan_authorities {
        if let Ok(authority) = host.parse::<axum::http::uri::Authority>() {
            origins.push(format!("http://{}:{port}", authority.host()));
        }
    }
    origins.extend(
        remote
            .exposure
            .content_hosts
            .iter()
            .map(|host| format!("https://{host}")),
    );
    format!("frame-src 'self' {}", origins.join(" "))
}
