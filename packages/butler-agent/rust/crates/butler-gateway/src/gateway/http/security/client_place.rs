//! Whether a request comes from this computer. Settings → Security answers
//! only such clients: a remote client, even with the token, cannot read the
//! connection code, rotate it or widen the gateway's exposure.
//!
//! A local client connects from a loopback address, names a loopback Host,
//! sends no Origin or one of this computer's pages (loopback, the App
//! renderer, the dev renderer), and carries no header a reverse proxy or
//! tunnel adds. A local proxy that forwards remote browsers (a tunnel that
//! rewrites Host to `127.0.0.1`) still connects from loopback, so its
//! forwarding headers and the remote page's Origin mark the request remote.

use std::net::SocketAddr;

use axum::http::HeaderMap;

use super::request_policy::{self, RequestOrigin};

/// Headers proxies and tunnels add. They are never trusted for Host or
/// client address; they only mark a request as forwarded.
const FORWARDING_HEADERS: [&str; 10] = [
    "forwarded",
    "via",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-server",
    "x-real-ip",
    "x-client-ip",
    "cf-connecting-ip",
    "true-client-ip",
];

/// Whether the request comes from this computer; `peer` is the TCP peer
/// (`None` when the listener did not record it, which fails closed).
pub(in crate::gateway::http) fn is_local_client(
    peer: Option<SocketAddr>,
    headers: &HeaderMap,
    origin: &RequestOrigin,
) -> bool {
    peer.is_some_and(|peer| peer.ip().to_canonical().is_loopback())
        && !FORWARDING_HEADERS
            .iter()
            .any(|name| headers.contains_key(*name))
        && request_policy::is_loopback_host(headers)
        && origin.is_local()
}
