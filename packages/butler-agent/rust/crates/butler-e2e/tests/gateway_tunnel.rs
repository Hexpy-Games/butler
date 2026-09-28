//! SEC. Tunnels the user runs (#229): their public host name is registered
//! with `butler gateway configure app --allowed-host`, applied without a
//! restart, and a tunneled request never reaches Settings → Security.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::Reply;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::security::{AdminClient, security_calls};
use reqwest::Method;
use serde_json::{Value, json};

/// A name for a tunnel the user runs (never resolved).
const TUNNEL_HOST: &str = "butler.example.info";

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

fn configure(s: &Scenario, flag: &str, name: &str) -> Result<Value, HarnessError> {
    let output = s
        .agent
        .cli(&["gateway", "configure", "app", flag, name, "--json"])?;
    assert_eq!(output.code, Some(0), "{output:?}");
    output.json()
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
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    assert!(!settings_file(&s).exists(), "fixture has gateways/app.json");
    let origin = format!("https://{TUNNEL_HOST}");
    let refused = through_tunnel(&s, Method::GET, "/settings", &origin, None).await?;
    assert_eq!(refused.status, 403, "{}", refused.text);
    assert_eq!(refused.error_code(), Some("origin_not_allowed"));

    // Without a settings file, the CLI creates a minimal valid one.
    configure(&s, "--allowed-host", "first.example.info")?;
    let mut stored: Value = serde_json::from_slice(&std::fs::read(settings_file(&s))?)?;
    assert_eq!(stored["id"], "app", "{stored}");
    assert_eq!(
        stored["config"]["allowedHosts"],
        json!(["first.example.info"])
    );
    stored["note"] = json!("keep");
    stored["config"]["custom"] = json!("keep");
    std::fs::write(settings_file(&s), stored.to_string())?;
    configure(&s, "--remove-allowed-host", "FIRST.example.info")?;

    let added = configure(&s, "--allowed-host", TUNNEL_HOST)?;
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
    assert_eq!(app.view().await?["allowed_hosts"], json!([TUNNEL_HOST]));

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

    let removed = configure(&s, "--remove-allowed-host", TUNNEL_HOST)?;
    assert_eq!(removed["data"]["config"]["allowedHosts"], json!([]));
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
    // An invalid host in the API changes nothing, not even the other fields.
    let before = app.send(Method::GET, "/settings", None, &[]).await?;
    let rejected = app
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"language": "en", "security": {"allowed_hosts": ["https://x/"]}})),
            &[],
        )
        .await?;
    assert_eq!(rejected.status, 400, "{}", rejected.text);
    let after = app.send(Method::GET, "/settings", None, &[]).await?;
    assert_eq!(after.data()["language"], before.data()["language"]);
    s.finish().await
}
