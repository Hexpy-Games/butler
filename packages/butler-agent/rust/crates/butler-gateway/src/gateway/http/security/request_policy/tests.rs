//! Host, Origin, local-client and Content-Type rules.

use super::super::client_place::is_local_client;
use super::super::lan::is_lan_address;
use super::*;
use crate::gateway::{AllowedHostError, normalize_allowed_host};

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

fn policy() -> RequestPolicy {
    RequestPolicy::new(
        "127.0.0.1:18765".parse().unwrap(),
        &["butler.lan".to_owned(), "box.local:443".to_owned()],
        Some("http://127.0.0.1:5173"),
        &["192.0.2.8:18765".to_owned(), "mac.local:18765".to_owned()],
    )
}

/// Security boundary: the Host names the gateway answers, the names
/// Settings and the CLI may add to them, and the addresses remote access
/// may bind.
// test-category: security
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
        ("192.0.2.8:18765", true),
        ("mac.local:18765", true),
        ("192.0.2.9:18765", false),
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

    let cases = [
        (" Butler.Example.Info ", Some("butler.example.info")),
        ("butler.local:18765", Some("butler.local:18765")),
        ("192.0.2.8", Some("192.0.2.8")),
        ("[fd00::1]:443", Some("[fd00::1]:443")),
        ("[::1]", Some("[::1]")),
        ("", None),
        ("https://butler.example.info", None),
        ("butler.example.info/path", None),
        ("user@butler.example.info", None),
        ("butler.example.info:0", None),
        ("butler.example.info:99999", None),
        ("fd00::1", None),
        ("-bad.example", None),
        ("two words", None),
    ];
    for (input, expected) in cases {
        assert_eq!(
            normalize_allowed_host(input).ok().as_deref(),
            expected,
            "{input:?}"
        );
    }
    assert_eq!(normalize_allowed_host("  "), Err(AllowedHostError::Empty));

    let cases = [
        ("192.168.0.20", true), // privacy-hygiene: allow-private-ip (LAN classification test)
        ("10.0.0.2", true),     // privacy-hygiene: allow-private-ip (LAN classification test)
        ("172.16.4.2", true),   // privacy-hygiene: allow-private-ip (LAN classification test)
        ("100.101.102.103", false),
        ("169.254.10.1", true),
        ("fd12:3456::1", true),
        ("::ffff:10.1.2.3", true), // privacy-hygiene: allow-private-ip (LAN classification test)
        ("127.0.0.1", false),
        ("::1", false),
        ("8.8.8.8", false),
        ("172.32.0.1", false),
        ("100.128.0.1", false),
        ("fe80::1", false),
        ("2001:db8::1", false),
        ("0.0.0.0", false),
    ];
    for (ip, lan) in cases {
        assert_eq!(is_lan_address(ip.parse().unwrap()), lan, "{ip}");
    }
}

/// Security boundary: the Host names browsers send Fetch Metadata to,
/// and the clients that count as this computer's for Settings →
/// Security (with the admin credential, checked separately).
// test-category: security
#[test]
fn loopback_hosts_and_local_clients() {
    let cases = [
        ("127.0.0.1:18765", true),
        ("LOCALHOST:18765", true),
        ("[::1]:18765", true),
        ("[::1]", true),
        ("127.8.0.1", true),
        ("preview.localhost:3000", true),
        ("localhost.attacker.example:18765", false),
        ("butler.lan:18765", false),
        ("192.0.2.10:18765", false),
        ("[fe80::1]:18765", false),
    ];
    for (host, loopback) in cases {
        assert_eq!(
            is_loopback_host(&headers(&[("host", host)])),
            loopback,
            "Host {host}"
        );
    }
    assert!(!is_loopback_host(&HeaderMap::new()));

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

/// Security boundary: raw-string Origin allowlist; `null` never passes.
// test-category: security
#[test]
fn origin_allowlist_compares_raw_strings() {
    let policy = policy();
    // Origin, allowed, a page on this computer.
    let cases = [
        ("app://butler", true, true),
        ("http://127.0.0.1:18765", true, true),
        ("http://localhost:18765", true, true),
        ("http://127.0.0.1:5173", true, true),
        ("https://butler.lan", true, false),
        ("http://butler.lan:18765", true, false),
        ("http://192.0.2.8:18765", true, false),
        ("http://mac.local:18765", true, false),
        ("https://192.0.2.8:18765", false, false),
        ("null", false, false),
        ("app://butler/", false, false),
        ("APP://BUTLER", false, false),
        ("http://localhost:3000", false, false),
        ("https://attacker.example", false, false),
    ];
    for (origin, allowed, local) in cases {
        let result = policy.classify_origin(&headers(&[("origin", origin)]));
        assert_eq!(result.is_ok(), allowed, "Origin {origin}");
        if let Ok(class) = result {
            assert_eq!(class.is_local(), local, "Origin {origin}");
        }
    }
    assert!(matches!(
        policy.classify_origin(&HeaderMap::new()),
        Ok(RequestOrigin::Absent)
    ));
}

type Headers = &'static [(&'static str, &'static str)];

#[test]
fn json_content_type_is_required_only_for_json_bodies() {
    const JSON: Headers = &[
        ("content-length", "2"),
        ("content-type", "application/json; charset=utf-8"),
    ];
    const TEXT: Headers = &[("content-length", "2"), ("content-type", "text/plain")];
    const CHUNKED: Headers = &[("transfer-encoding", "chunked")];
    const EMPTY: Headers = &[("content-length", "0")];
    // Method, path, request headers, whether the body rule admits it.
    let cases: [(Method, &str, Headers, bool); 7] = [
        (Method::POST, "/messages", JSON, true),
        (Method::POST, "/messages", TEXT, false),
        (Method::PATCH, "/settings", CHUNKED, false),
        (Method::POST, "/turns/t/cancel", EMPTY, true),
        (Method::DELETE, "/session-queue/q", &[], true),
        (Method::POST, "/message-files", TEXT, true),
        (Method::GET, "/settings", TEXT, true),
    ];
    for (method, path, pairs, allowed) in cases {
        let result = require_json_body(&method, path, &headers(pairs));
        assert_eq!(result.is_ok(), allowed, "{method} {path}");
    }
}
