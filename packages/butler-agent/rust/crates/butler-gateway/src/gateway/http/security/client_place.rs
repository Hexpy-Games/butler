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

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_static(value));
        }
        headers
    }

    fn origin(value: &'static str, local: bool) -> RequestOrigin {
        RequestOrigin::Allowed {
            value: HeaderValue::from_static(value),
            local,
        }
    }

    struct Case {
        name: &'static str,
        peer: Option<&'static str>,
        headers: &'static [(&'static str, &'static str)],
        origin: RequestOrigin,
        local: bool,
    }

    const LOOPBACK: Option<&str> = Some("127.0.0.1:50000");
    const HOST: (&str, &str) = ("host", "127.0.0.1:18765");

    /// Security boundary: who may read or change Settings → Security.
    #[test]
    fn only_unforwarded_loopback_clients_with_local_origins_are_local() {
        let absent = || RequestOrigin::Absent;
        let cases = [
            Case {
                name: "CLI / App",
                peer: LOOPBACK,
                headers: &[HOST],
                origin: absent(),
                local: true,
            },
            Case {
                name: "IPv6 loopback",
                peer: Some("[::1]:50000"),
                headers: &[("host", "[::1]:18765")],
                origin: absent(),
                local: true,
            },
            Case {
                name: "mapped loopback",
                peer: Some("[::ffff:127.0.0.1]:50000"),
                headers: &[HOST],
                origin: absent(),
                local: true,
            },
            Case {
                name: "App renderer",
                peer: LOOPBACK,
                headers: &[HOST],
                origin: origin("app://butler", true),
                local: true,
            },
            Case {
                name: "LAN peer",
                peer: Some("192.0.2.20:50000"),
                headers: &[("host", "192.0.2.8:18765")],
                origin: absent(),
                local: false,
            },
            Case {
                name: "unknown peer",
                peer: None,
                headers: &[HOST],
                origin: absent(),
                local: false,
            },
            Case {
                name: "tunnel origin",
                peer: LOOPBACK,
                headers: &[HOST],
                origin: origin("https://butler.example.info", false),
                local: false,
            },
            Case {
                name: "forwarded",
                peer: LOOPBACK,
                headers: &[HOST, ("x-forwarded-for", "203.0.113.9")],
                origin: absent(),
                local: false,
            },
            Case {
                name: "cloudflared",
                peer: LOOPBACK,
                headers: &[HOST, ("cf-connecting-ip", "203.0.113.9")],
                origin: absent(),
                local: false,
            },
            Case {
                name: "LAN host name",
                peer: LOOPBACK,
                headers: &[("host", "mac.local:18765")],
                origin: absent(),
                local: false,
            },
        ];
        for case in cases {
            let peer = case.peer.map(|peer| peer.parse().unwrap());
            assert_eq!(
                is_local_client(peer, &headers(case.headers), &case.origin),
                case.local,
                "{}",
                case.name
            );
        }
    }
}
