//! SEC. Settings → Security (#229): access from other computers. Remote
//! access binds the gateway's port on the LAN addresses (and unbinds it)
//! without a restart, host names for a tunnel the user runs are registered
//! with `butler gateway configure app --allowed-host`, and only a client on
//! this computer may read or change any of it. The connection code is in
//! `gateway_rotation.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::{Gateway, Reply};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use reqwest::Method;
use serde_json::{Value, json};

/// A name for a tunnel the user runs (never resolved).
const TUNNEL_HOST: &str = "butler.example.info";

/// The Settings → Security view.
async fn security(gw: &Gateway) -> Result<Value, HarnessError> {
    let reply = gw.get("/security").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

async fn set_remote(gw: &Gateway, enabled: bool) -> Result<Value, HarnessError> {
    let reply = gw
        .patch(
            "/settings",
            json!({"security": {"remote_access_enabled": enabled}}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["security"]["remote_access_enabled"], enabled);
    security(gw).await
}

/// The security routes, each with a way to change something.
fn security_calls() -> [(Method, &'static str, Option<String>); 4] {
    [
        (Method::GET, "/security", None),
        (Method::POST, "/security/connection-code/reveal", None),
        (Method::POST, "/security/connection-code/rotate", None),
        (
            Method::PATCH,
            "/settings",
            Some(json!({"security": {"remote_access_enabled": true}}).to_string()),
        ),
    ]
}

/// Every security call through `gw` with `headers` is refused as remote.
async fn assert_refused_as_remote(
    gw: &Gateway,
    headers: &[(&str, &str)],
    label: &str,
) -> Result<(), HarnessError> {
    for (method, path, body) in security_calls() {
        let reply = gw
            .send_with(method.clone(), path, body, Some(&gw.token), headers)
            .await?;
        assert_eq!(reply.status, 403, "{label} {method} {path}: {}", reply.text);
        assert_eq!(reply.error_code(), Some("loopback_required"), "{label}");
    }
    let settings = gw
        .send_with(Method::GET, "/settings", None, Some(&gw.token), headers)
        .await?;
    assert_eq!(settings.status, 200, "{label}: {}", settings.text);
    assert!(
        settings.data()["security"].is_null(),
        "{label} read security"
    );
    Ok(())
}

/// The gateway's LAN listeners (every bind address but the loopback one).
fn lan_listeners(view: &Value) -> Vec<String> {
    view["bind_addresses"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|address| address.as_str().unwrap().to_owned())
        .collect()
}

/// Waits until nothing accepts connections on `address`.
async fn wait_unbound(address: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while tokio::net::TcpStream::connect(address).await.is_ok() {
        assert!(Instant::now() < deadline, "{address} still accepts");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// SEC-09 — "Allow access from other computers": off by default (loopback
/// only); on binds every LAN address on the same port and answers its LAN
/// names, without a restart; off unbinds them. A remote client, even with
/// the token, cannot read the connection code, rotate it or change the
/// exposure: neither from a LAN address nor through a local proxy. The
/// setting survives a restart.
#[tokio::test]
async fn sec_09_lan_access_binds_and_unbinds_without_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-09")?.data_folder_token().start().await?;
    let port = s.agent.launch.port;
    let loopback = format!("127.0.0.1:{port}");
    let view = security(&s.gw).await?;
    assert_eq!(view["remote_access_enabled"], false, "{view}");
    assert_eq!(view["bind_addresses"], json!([loopback]), "{view}");
    assert_eq!(view["lan_urls"], json!([]), "{view}");
    let token = s.gw.token.clone();
    let masked = format!("{}…{}", &token[..4], &token[token.len() - 4..]);
    assert_eq!(view["connection_code"]["masked"], masked, "{view}");
    assert!(view["connection_code"]["created_at"].is_string(), "{view}");
    let settings = s.gw.settings().await?;
    assert_eq!(
        settings["security"],
        json!({"remote_access_enabled": false, "allowed_hosts": []})
    );

    // A local proxy forwarding a remote browser is not a local client.
    for header in [
        ("x-forwarded-for", "203.0.113.9"),
        ("forwarded", "for=203.0.113.9"),
        ("cf-connecting-ip", "203.0.113.9"),
    ] {
        assert_refused_as_remote(&s.gw, &[header], header.0).await?;
    }
    assert_eq!(security(&s.gw).await?["remote_access_enabled"], false);

    let view = set_remote(&s.gw, true).await?;
    assert_eq!(view["remote_access_enabled"], true, "{view}");
    assert_eq!(view["bind_addresses"][0], loopback, "{view}");
    let stored: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("gateways/app.json"))?)?;
    assert_eq!(stored["config"]["remoteAccessEnabled"], true, "{stored}");
    let lan = lan_listeners(&view);
    let urls = view["lan_urls"].as_array().unwrap();
    if lan.is_empty() {
        eprintln!("SEC-09: this machine has no LAN address; LAN listener checks skipped");
        assert!(urls.is_empty(), "{view}");
    } else {
        for address in &lan {
            assert!(
                urls.contains(&json!(format!("http://{address}"))),
                "{address} not in {view}"
            );
        }
        assert_lan_client(&s, &lan[0], urls).await?;
    }

    let view = set_remote(&s.gw, false).await?;
    assert_eq!(view["bind_addresses"], json!([loopback]), "{view}");
    assert_eq!(view["lan_urls"], json!([]), "{view}");
    for address in &lan {
        wait_unbound(address).await;
    }

    // The next start binds as the saved setting says.
    set_remote(&s.gw, true).await?;
    s.restart().await?;
    let view = security(&s.gw).await?;
    assert_eq!(view["remote_access_enabled"], true, "{view}");
    if let Some(address) = lan_listeners(&view).first() {
        let health = lan_gateway(&s, address).get("/health").await?;
        assert_eq!(health.status, 200, "after restart: {}", health.text);
    }
    set_remote(&s.gw, false).await?;
    s.finish().await
}

fn lan_gateway(s: &Scenario, address: &str) -> Gateway {
    Gateway::new(format!("http://{address}"), s.gw.token.clone())
}

/// A client on the LAN (this machine, through its LAN address, so the peer
/// is not loopback): it reaches the gateway with the token, and its page's
/// origin may change settings, but Settings → Security refuses it.
async fn assert_lan_client(
    s: &Scenario,
    address: &str,
    urls: &[Value],
) -> Result<(), HarnessError> {
    let remote = lan_gateway(s, address);
    assert_eq!(remote.get("/health").await?.status, 200, "{address}");
    let anonymous = remote
        .send_with(Method::GET, "/settings", None, None, &[])
        .await?;
    assert_eq!(
        anonymous.status, 401,
        "LAN without token: {}",
        anonymous.text
    );
    let origin = format!("http://{address}");
    let changed = remote
        .send_with(
            Method::PATCH,
            "/settings",
            Some(json!({"language": "ko"}).to_string()),
            Some(&remote.token),
            &[("origin", &origin)],
        )
        .await?;
    assert_eq!(changed.status, 200, "LAN page PATCH: {}", changed.text);
    assert_refused_as_remote(&remote, &[], "LAN peer").await?;
    let named = urls
        .iter()
        .filter_map(Value::as_str)
        .find(|url| url.contains(".local:"));
    if let Some(url) = named {
        let host = url.trim_start_matches("http://");
        let reply = remote
            .send_with(
                Method::GET,
                "/health",
                None,
                Some(&remote.token),
                &[("host", host)],
            )
            .await?;
        assert_eq!(reply.status, 200, "{host}: {}", reply.text);
    }
    let foreign = remote
        .send_with(
            Method::GET,
            "/health",
            None,
            Some(&remote.token),
            &[("host", "attacker.example")],
        )
        .await?;
    assert_eq!(foreign.error_code(), Some("host_not_allowed"));
    Ok(())
}

/// Sends what a tunnel's local proxy forwards: Host rewritten to the
/// loopback address, the browser's Origin, the token.
async fn through_tunnel(
    s: &Scenario,
    method: Method,
    path: &str,
    origin: &str,
    body: Option<Value>,
) -> Result<Reply, HarnessError> {
    let host = format!("127.0.0.1:{}", s.agent.launch.port);
    s.gw.send_with(
        method,
        path,
        body.map(|body| body.to_string()),
        Some(&s.gw.token),
        &[
            ("host", &host),
            ("origin", origin),
            ("x-forwarded-for", "203.0.113.9"),
        ],
    )
    .await
}

/// SEC-11 — a tunnel the user built (`name` → proxy that rewrites Host to
/// 127.0.0.1 and passes Origin through): its browser origin is refused until
/// the name is registered with `butler gateway configure app
/// --allowed-host`, which the running gateway applies without a restart and
/// which keeps the rest of `gateways/app.json`. Unregistered names stay
/// refused, removing the name refuses it again, and the tunnel never
/// reaches Settings → Security.
#[tokio::test]
async fn sec_11_tunnel_host_is_registered_with_the_cli() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let settings_file = |s: &Scenario| s.sandbox.data.join("gateways/app.json");
    let s = Setup::new("SEC-11")?.data_folder_token().start().await?;
    assert!(!settings_file(&s).exists(), "fixture has gateways/app.json");
    let origin = format!("https://{TUNNEL_HOST}");
    let refused = through_tunnel(&s, Method::GET, "/settings", &origin, None).await?;
    assert_eq!(refused.status, 403, "{}", refused.text);
    assert_eq!(refused.error_code(), Some("origin_not_allowed"));

    // Without a settings file, the CLI creates a minimal valid one.
    let created = s.agent.cli(&[
        "gateway",
        "configure",
        "app",
        "--allowed-host",
        "first.example.info",
        "--json",
    ])?;
    assert_eq!(created.code, Some(0), "{created:?}");
    let mut stored: Value = serde_json::from_slice(&std::fs::read(settings_file(&s))?)?;
    assert_eq!(stored["id"], "app", "{stored}");
    assert_eq!(
        stored["config"]["allowedHosts"],
        json!(["first.example.info"]),
        "{stored}"
    );
    stored["note"] = json!("keep");
    stored["config"]["custom"] = json!("keep");
    std::fs::write(settings_file(&s), stored.to_string())?;
    let removed_first = s.agent.cli(&[
        "gateway",
        "configure",
        "app",
        "--remove-allowed-host",
        "FIRST.example.info",
        "--json",
    ])?;
    assert_eq!(removed_first.code, Some(0), "{removed_first:?}");

    let added = s.agent.cli(&[
        "gateway",
        "configure",
        "app",
        "--allowed-host",
        TUNNEL_HOST,
        "--json",
    ])?;
    assert_eq!(added.code, Some(0), "{added:?}");
    let added = added.json()?;
    assert_eq!(
        added["data"]["config"]["allowedHosts"],
        json!([TUNNEL_HOST]),
        "{added}"
    );
    assert_eq!(added["data"]["allowedHostsApplied"], true, "{added}");
    let stored: Value = serde_json::from_slice(&std::fs::read(settings_file(&s))?)?;
    assert_eq!(stored["note"], "keep", "{stored}");
    assert_eq!(stored["config"]["custom"], "keep", "{stored}");
    assert_eq!(
        stored["config"]["allowedHosts"],
        json!([TUNNEL_HOST]),
        "{stored}"
    );
    assert_eq!(
        security(&s.gw).await?["allowed_hosts"],
        json!([TUNNEL_HOST])
    );

    let read = through_tunnel(&s, Method::GET, "/settings", &origin, None).await?;
    assert_eq!(read.status, 200, "{}", read.text);
    let write = through_tunnel(
        &s,
        Method::PATCH,
        "/settings",
        &origin,
        Some(json!({"language": "ko"})),
    )
    .await?;
    assert_eq!(write.status, 200, "{}", write.text);
    for (method, path, body) in security_calls() {
        let body = body.map(|body| serde_json::from_str(&body).unwrap());
        let reply = through_tunnel(&s, method.clone(), path, &origin, body).await?;
        assert_eq!(
            reply.error_code(),
            Some("loopback_required"),
            "{method} {path}"
        );
    }
    let passthrough =
        s.gw.send_with(
            Method::GET,
            "/health",
            None,
            Some(&s.gw.token),
            &[("host", TUNNEL_HOST)],
        )
        .await?;
    assert_eq!(passthrough.status, 200, "{}", passthrough.text);
    let other = through_tunnel(
        &s,
        Method::GET,
        "/settings",
        "https://other.example.info",
        None,
    )
    .await?;
    assert_eq!(
        other.error_code(),
        Some("origin_not_allowed"),
        "{}",
        other.text
    );
    let other_host =
        s.gw.send_with(
            Method::GET,
            "/health",
            None,
            Some(&s.gw.token),
            &[("host", "other.example.info")],
        )
        .await?;
    assert_eq!(other_host.error_code(), Some("host_not_allowed"));

    let removed = s.agent.cli(&[
        "gateway",
        "configure",
        "app",
        "--remove-allowed-host",
        TUNNEL_HOST,
        "--json",
    ])?;
    assert_eq!(removed.code, Some(0), "{removed:?}");
    assert_eq!(removed.json()?["data"]["config"]["allowedHosts"], json!([]));
    let refused = through_tunnel(&s, Method::GET, "/settings", &origin, None).await?;
    assert_eq!(refused.error_code(), Some("origin_not_allowed"));

    let invalid = s.agent.cli(&[
        "gateway",
        "configure",
        "app",
        "--allowed-host",
        "https://x.example/",
        "--json",
    ])?;
    assert_ne!(invalid.code, Some(0), "{invalid:?}");
    s.finish().await
}
