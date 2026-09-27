//! Host and Origin admission for every request, and the JSON Content-Type
//! rule for request bodies.
//!
//! The Host check stops DNS rebinding: a page on an attacker's name that
//! resolves to loopback still sends its own name as Host. The Origin
//! allowlist stops cross-site requests from browsers, which always send
//! Origin on cross-origin fetches and state-changing requests; clients
//! without a browser send none. Origins are compared as the raw header
//! string: URL parsers serialize opaque origins such as `app://butler` as
//! `null`.

use std::collections::HashSet;
use std::net::SocketAddr;

use axum::http::{HeaderMap, HeaderValue, Method, header};

use super::super::HttpError;

/// The renderer origin of the packaged desktop App.
const APP_ORIGIN: &str = "app://butler";
/// Loopback names the gateway always answers, with its bound port.
const LOOPBACK_NAMES: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
/// Routes whose bodies are multipart uploads, not JSON.
const MULTIPART_ROUTES: [&str; 2] = ["/message-files", "/skills/import"];

/// Where a request says it comes from (its raw `Origin` header).
#[derive(Clone, Debug)]
pub(in crate::gateway::http) enum RequestOrigin {
    /// No `Origin` header: a client without a browser, or a same-origin
    /// navigation or `GET`.
    Absent,
    /// An allowlisted browser origin, echoed in CORS response headers.
    Allowed(HeaderValue),
}

impl RequestOrigin {
    /// The origin to echo in `Access-Control-Allow-Origin`, if any.
    pub(in crate::gateway::http) fn allowed(&self) -> Option<&HeaderValue> {
        match self {
            Self::Absent => None,
            Self::Allowed(origin) => Some(origin),
        }
    }
}

/// The Host names and browser origins this gateway answers.
pub(in crate::gateway::http) struct RequestPolicy {
    hosts: HashSet<String>,
    origins: HashSet<String>,
}

impl RequestPolicy {
    /// Loopback names and the literal bound address (with the bound port),
    /// the App origin, the dev renderer origins (comma-separated, only when
    /// configured) and the operator's extra host names.
    pub(in crate::gateway::http) fn new(
        local_addr: SocketAddr,
        allowed_hosts: &[String],
        dev_origins: Option<&str>,
    ) -> Self {
        let port = local_addr.port();
        let mut policy = Self {
            hosts: HashSet::new(),
            origins: HashSet::from([APP_ORIGIN.to_owned()]),
        };
        for name in LOOPBACK_NAMES {
            policy.allow_plain_http(&format!("{name}:{port}"));
        }
        policy.allow_plain_http(&local_addr.to_string());
        for entry in allowed_hosts {
            policy.allow_configured_host(entry, port);
        }
        let dev_origins = dev_origins.unwrap_or_default().split(',').map(str::trim);
        policy.origins.extend(
            dev_origins
                .filter(|origin| !origin.is_empty() && *origin != "null")
                .map(str::to_owned),
        );
        policy
    }

    fn allow_plain_http(&mut self, authority: &str) {
        let authority = authority.to_ascii_lowercase();
        self.origins.insert(format!("http://{authority}"));
        self.hosts.insert(authority);
    }

    /// `name` answers Host `name` and `name:<bound port>`; `name:port`
    /// answers exactly that. Both schemes are allowed as origins, so a TLS
    /// reverse proxy in front of the gateway works.
    fn allow_configured_host(&mut self, entry: &str, port: u16) {
        let entry = entry.trim().to_ascii_lowercase();
        if entry.is_empty() || entry.contains(['/', '@', '?', '#', ' ']) {
            return;
        }
        let authorities = if has_port(&entry) {
            vec![entry]
        } else {
            vec![format!("{entry}:{port}"), entry]
        };
        for authority in authorities {
            self.origins.insert(format!("http://{authority}"));
            self.origins.insert(format!("https://{authority}"));
            self.hosts.insert(authority);
        }
    }

    /// Refuses a request whose Host is missing, repeated or not ours.
    pub(in crate::gateway::http) fn check_host(
        &self,
        headers: &HeaderMap,
    ) -> Result<(), HttpError> {
        let mut values = headers.get_all(header::HOST).iter();
        let (Some(host), None) = (values.next(), values.next()) else {
            return Err(host_not_allowed());
        };
        let host = host.to_str().map_err(|_| host_not_allowed())?;
        if self.hosts.contains(&host.to_ascii_lowercase()) {
            Ok(())
        } else {
            Err(host_not_allowed())
        }
    }

    /// Classifies the raw `Origin` header; any origin not on the allowlist,
    /// including `null`, is refused.
    pub(in crate::gateway::http) fn classify_origin(
        &self,
        headers: &HeaderMap,
    ) -> Result<RequestOrigin, HttpError> {
        let mut values = headers.get_all(header::ORIGIN).iter();
        match (values.next(), values.next()) {
            (None, _) => Ok(RequestOrigin::Absent),
            (Some(origin), None)
                if origin
                    .to_str()
                    .is_ok_and(|value| self.origins.contains(value)) =>
            {
                Ok(RequestOrigin::Allowed(origin.clone()))
            }
            _ => Err(HttpError::public(
                403,
                "origin_not_allowed",
                "Requests from this origin are not allowed.",
            )),
        }
    }
}

/// A request that sends a body must send JSON, except to the multipart
/// upload routes. Body-less `POST`/`DELETE` (cancel, remove) need no type.
pub(in crate::gateway::http) fn require_json_body(
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Result<(), HttpError> {
    let sends_body = matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) && declares_body(headers);
    if !sends_body || MULTIPART_ROUTES.contains(&path) || is_json(headers) {
        return Ok(());
    }
    Err(HttpError::public(
        415,
        "unsupported_media_type",
        "Request bodies must be sent as application/json.",
    ))
}

fn declares_body(headers: &HeaderMap) -> bool {
    headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get_all(header::CONTENT_LENGTH)
            .iter()
            .any(|value| value.to_str().map_or(true, |length| length.trim() != "0"))
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
}

/// Whether an authority ends in `:port` (an IPv6 literal alone does not).
fn has_port(authority: &str) -> bool {
    authority.rsplit_once(':').is_some_and(|(host, port)| {
        !port.is_empty()
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && (!host.starts_with('[') || host.ends_with(']'))
    })
}

fn host_not_allowed() -> HttpError {
    HttpError::public(
        403,
        "host_not_allowed",
        "This Butler gateway does not answer that host name.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_static(value));
        }
        headers
    }

    fn policy() -> RequestPolicy {
        RequestPolicy::new(
            "127.0.0.1:18765".parse().unwrap(),
            &["butler.lan".to_owned(), "box.local:443".to_owned()],
            Some("http://127.0.0.1:5173"),
        )
    }

    /// Security boundary: the Host names the gateway answers.
    #[test]
    fn host_allowlist_is_loopback_with_port_plus_configured_names() {
        let policy = policy();
        let cases = [
            ("127.0.0.1:18765", true),
            ("LOCALHOST:18765", true),
            ("[::1]:18765", true),
            ("butler.lan", true),
            ("butler.lan:18765", true),
            ("box.local:443", true),
            ("localhost", false),
            ("localhost:5173", false),
            ("box.local", false),
            ("attacker.example:18765", false),
        ];
        for (host, allowed) in cases {
            let result = policy.check_host(&headers(&[("host", host)]));
            assert_eq!(result.is_ok(), allowed, "Host {host}");
        }
        assert!(policy.check_host(&HeaderMap::new()).is_err());
        let repeated = headers(&[("host", "127.0.0.1:18765"), ("host", "127.0.0.1:18765")]);
        assert!(policy.check_host(&repeated).is_err());
    }

    /// Security boundary: raw-string Origin allowlist; `null` never passes.
    #[test]
    fn origin_allowlist_compares_raw_strings() {
        let policy = policy();
        let cases = [
            ("app://butler", true),
            ("http://127.0.0.1:18765", true),
            ("http://localhost:18765", true),
            ("http://127.0.0.1:5173", true),
            ("https://butler.lan", true),
            ("http://butler.lan:18765", true),
            ("null", false),
            ("app://butler/", false),
            ("APP://BUTLER", false),
            ("http://localhost:3000", false),
            ("https://attacker.example", false),
        ];
        for (origin, allowed) in cases {
            let result = policy.classify_origin(&headers(&[("origin", origin)]));
            assert_eq!(result.is_ok(), allowed, "Origin {origin}");
        }
        assert!(matches!(
            policy.classify_origin(&HeaderMap::new()),
            Ok(RequestOrigin::Absent)
        ));
    }

    #[test]
    fn json_content_type_is_required_only_for_json_bodies() {
        let json = [
            ("content-length", "2"),
            ("content-type", "application/json; charset=utf-8"),
        ];
        let text = [("content-length", "2"), ("content-type", "text/plain")];
        let empty = [("content-length", "0")];
        let cases: [(Method, &str, &[(&'static str, &'static str)], bool); 7] = [
            (Method::POST, "/messages", &json, true),
            (Method::POST, "/messages", &text, false),
            (
                Method::PATCH,
                "/settings",
                &[("transfer-encoding", "chunked")],
                false,
            ),
            (Method::POST, "/turns/t/cancel", &empty, true),
            (Method::DELETE, "/session-queue/q", &[], true),
            (Method::POST, "/message-files", &text, true),
            (Method::GET, "/settings", &text, true),
        ];
        for (method, path, pairs, allowed) in cases {
            let result = require_json_body(&method, path, &headers(pairs));
            assert_eq!(result.is_ok(), allowed, "{method} {path}");
        }
    }
}
