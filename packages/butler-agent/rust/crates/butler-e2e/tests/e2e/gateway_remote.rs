//! SEC. Settings → Security (#229): access from other computers. Remote
//! access binds the gateway's port on the LAN addresses (and unbinds it)
//! without a restart, and only the App or the CLI on this computer may
//! read or change it: a loopback client that also sends the local admin
//! credential. Tunnel host names are in `gateway_tunnel.rs`, the connection
//! code in `gateway_rotation.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::ADMIN_HEADER;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::security::{AdminClient, security_calls};
use reqwest::Method;
use serde_json::{Value, json};

fn admin(s: &Scenario) -> AdminClient {
    let secret = s
        .agent
        .launch
        .admin_credential()
        .expect("the agent created the admin credential");
    AdminClient::new(s.gw.clone(), secret)
}

/// Every security call through `gw` with `headers` gets 403 `code`, and
/// `GET /settings` carries no `security`.
async fn assert_refused(
    gw: &Gateway,
    headers: &[(&str, &str)],
    code: &str,
    label: &str,
) -> Result<(), HarnessError> {
    for (method, path, body) in security_calls() {
        let body = body.map(|body| body.to_string());
        let reply = gw
            .send_with(method.clone(), path, body, Some(&gw.token), headers)
            .await?;
        assert_eq!(reply.status, 403, "{label} {method} {path}: {}", reply.text);
        assert_eq!(reply.error_code(), Some(code), "{label} {method} {path}");
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
    let mut listeners: Vec<_> = view["bind_addresses"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|address| address.as_str().unwrap().to_owned())
        .collect();
    listeners.sort();
    listeners
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
/// the token and the admin credential, cannot read the connection code,
/// rotate it or change the exposure: neither from a LAN address nor through
/// a local proxy that marks the request as forwarded. The setting survives
/// a restart.
#[tokio::test]
async fn sec_09_lan_access_binds_and_unbinds_without_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-09")?.data_folder_token().start().await?;
    let app = admin(&s);
    let port = s.agent.launch.port;
    let loopback = format!("127.0.0.1:{port}");
    let view = app.view().await?;
    assert_eq!(view["remote_access_enabled"], false, "{view}");
    assert_eq!(view["bind_addresses"], json!([loopback]), "{view}");
    assert_eq!(view["lan_urls"], json!([]), "{view}");
    assert!(view["connection_code"].is_null(), "token metadata exposed");
    assert!(!view.to_string().contains(&s.gw.token));
    let settings = app.send(Method::GET, "/settings", None, &[]).await?;
    assert_eq!(
        settings.data()["security"],
        json!({"remote_access_enabled": false, "allowed_hosts": []})
    );

    // A local proxy that forwards a remote browser is not a local client,
    // whatever credentials it passes along.
    for header in [
        ("x-forwarded-for", "203.0.113.9"),
        ("forwarded", "for=203.0.113.9"),
        ("cf-connecting-ip", "203.0.113.9"),
    ] {
        let headers = [header, (ADMIN_HEADER, app.admin.as_str())];
        assert_refused(&s.gw, &headers, "loopback_required", header.0).await?;
    }
    assert_eq!(app.view().await?["remote_access_enabled"], false);

    let view = app.set_remote(true).await?;
    assert_lan_port(&view, port);
    assert_eq!(view["remote_access_enabled"], true, "{view}");
    assert_eq!(view["bind_addresses"][0], loopback, "{view}");
    let stored: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("gateways/app.json"))?)?;
    assert_eq!(stored["config"]["remoteAccessEnabled"], true, "{stored}");
    let lan = lan_listeners(&view);
    let urls = view["lan_urls"].as_array().unwrap();
    if std::env::var_os("BUTLER_E2E_REQUIRE_LAN").is_some() {
        assert!(
            !lan.is_empty(),
            "LAN smoke requires a bound listener: {view}"
        );
    }
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
        assert_lan_client(&app, &lan[0], urls).await?;
    }

    let view = app.set_remote(false).await?;
    assert_eq!(view["bind_addresses"], json!([loopback]), "{view}");
    assert_eq!(view["lan_urls"], json!([]), "{view}");
    for address in &lan {
        wait_unbound(address).await;
    }

    // The next start binds as the saved setting says.
    app.set_remote(true).await?;
    s.restart().await?;
    let app = AdminClient::new(s.gw.clone(), app.admin);
    let view = app.view().await?;
    assert_eq!(view["remote_access_enabled"], true, "{view}");
    assert_lan_port(&view, port);
    if let Some(address) = lan_listeners(&view).first() {
        let lan = Gateway::new(format!("http://{address}"), s.gw.token.clone());
        let health = lan.get("/health").await?;
        assert_eq!(health.status, 200, "after restart: {}", health.text);
    }
    app.set_remote(false).await?;
    s.finish().await
}

/// A client on the LAN (this machine, through its LAN address, so the peer
/// is not loopback): it reaches the gateway with the token, and its page's
/// origin may change settings, but Settings → Security refuses it even
/// with the admin credential.
async fn assert_lan_client(
    app: &AdminClient,
    address: &str,
    urls: &[Value],
) -> Result<(), HarnessError> {
    let remote = Gateway::new(format!("http://{address}"), app.gw.token.clone());
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
    let with_admin = [(ADMIN_HEADER, app.admin.as_str())];
    assert_refused(&remote, &with_admin, "loopback_required", "LAN peer").await?;
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

/// A plain TCP forwarder on this computer (as `ssh -L`, `socat` or a
/// container port mapping would be): it adds no header, and the gateway
/// sees a loopback peer.
async fn tcp_forwarder(target: u16) -> Result<u16, HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut outbound) =
                    tokio::net::TcpStream::connect(("127.0.0.1", target)).await
                {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    Ok(port)
}

/// SEC-12 — a header-less forwarder to 127.0.0.1 passes every network
/// check a local client passes (loopback peer, loopback Host, no Origin,
/// no proxy header), yet with the gateway token alone it cannot read or
/// change Settings → Security: that needs the local admin credential,
/// which only the App and the CLI read from the data folder.
#[tokio::test]
async fn sec_12_header_less_forwarder_needs_the_admin_credential() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-12")?.data_folder_token().start().await?;
    let app = admin(&s);
    let port = s.agent.launch.port;
    let forwarded = tcp_forwarder(port).await?;
    let through = Gateway::new(format!("http://127.0.0.1:{forwarded}"), s.gw.token.clone());
    let host = format!("127.0.0.1:{port}");
    let health = through
        .send_with(
            Method::GET,
            "/health",
            None,
            Some(&through.token),
            &[("host", &host)],
        )
        .await?;
    assert_eq!(health.status, 200, "forwarder: {}", health.text);
    assert_refused(
        &through,
        &[("host", &host)],
        "admin_credential_required",
        "forwarder",
    )
    .await?;
    let wrong = [
        ("host", host.as_str()),
        (ADMIN_HEADER, "not-the-admin-credential"),
    ];
    assert_refused(&through, &wrong, "admin_credential_required", "wrong admin").await?;
    assert_eq!(
        app.view().await?["remote_access_enabled"],
        false,
        "state changed"
    );
    assert!(app.view().await?["connection_code"].is_null());
    assert_eq!(
        s.agent.launch.data_folder_token().as_deref(),
        Some(s.gw.token.as_str())
    );
    s.finish().await
}

/// Every discovered LAN address is accounted for at the App's actual port.
fn assert_lan_port(view: &Value, port: u16) {
    let bound = lan_listeners(view);
    let errors = view["bind_errors"].as_array().unwrap();
    for ip in lan_addresses() {
        let address = std::net::SocketAddr::new(ip, port).to_string();
        assert!(
            bound.contains(&address) || errors.iter().any(|error| error["address"] == address),
            "LAN address {address} missing from {view}"
        );
    }
    for address in bound {
        assert_eq!(
            address.parse::<std::net::SocketAddr>().unwrap().port(),
            port
        );
    }
    for url in view["lan_urls"].as_array().unwrap() {
        assert!(
            url.as_str().unwrap().ends_with(&format!(":{port}")),
            "{view}"
        );
    }
}

fn lan_addresses() -> Vec<std::net::IpAddr> {
    let mut addresses: Vec<_> = butler_platform::network::external_addresses()
        .unwrap_or_default()
        .into_iter()
        .filter(|ip| match ip.to_canonical() {
            std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
            std::net::IpAddr::V6(ip) => ip.segments()[0] & 0xfe00 == 0xfc00,
        })
        .collect();
    if std::env::var_os("BUTLER_E2E_REQUIRE_LAN").is_some() {
        assert!(!addresses.is_empty(), "LAN smoke requires a LAN address");
    }
    addresses.sort();
    addresses
}

/// Fixed configured port, including saved exposure at initial admission and
/// after restart. Never bind the owner's production port.
#[tokio::test]
async fn sec_09_fixed_port_lan_access_survives_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let reserved = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = reserved.local_addr()?.port();
    assert_ne!(port, 18765);
    let setup = Setup::new("SEC-09-FIXED")?
        .data_folder_token()
        .env("BUTLER_APP_SERVER_PORT", port.to_string());
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"port": port, "remoteAccessEnabled": true}}).to_string(),
    )?;
    drop(reserved);
    let mut s = setup.start().await?;
    let app = admin(&s);
    for start in 0..2 {
        let view = app.view().await?;
        assert_eq!(view["remote_access_enabled"], true, "{view}");
        assert_eq!(view["bind_addresses"][0], format!("127.0.0.1:{port}"));
        assert_lan_port(&view, port);
        assert_eq!(view["bind_errors"], json!([]), "{view}");
        let lan = lan_listeners(&view);
        for address in &lan {
            let remote = Gateway::new(format!("http://{address}"), s.gw.token.clone());
            assert_eq!(remote.get("/health").await?.status, 200, "{address}");
        }
        let view = app.set_remote(false).await?;
        assert_eq!(view["bind_addresses"], json!([format!("127.0.0.1:{port}")]));
        assert_eq!(view["bind_errors"], json!([]));
        for address in &lan {
            wait_unbound(address).await;
        }
        let view = app.set_remote(true).await?;
        assert_lan_port(&view, port);
        assert_eq!(view["bind_errors"], json!([]), "{view}");
        if start == 0 {
            s.restart().await?;
        }
    }
    app.set_remote(false).await?;
    s.finish().await
}

/// An occupied LAN address is reported without claiming it is reachable.
#[tokio::test]
async fn sec_09_lan_bind_failure_reports_the_address() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(ip) = lan_addresses().first().copied() else {
        eprintln!("SEC-09 bind failure: this machine has no LAN address");
        return Ok(());
    };
    let occupied = tokio::net::TcpListener::bind((ip, 0)).await?;
    let address = occupied.local_addr()?;
    assert_ne!(address.port(), 18765);
    let s = Setup::new("SEC-09-BIND-FAILURE")?
        .data_folder_token()
        .env("BUTLER_APP_SERVER_PORT", address.port().to_string())
        .start()
        .await?;
    let app = admin(&s);
    let view = app.set_remote(true).await?;
    assert_eq!(view["remote_access_enabled"], true, "{view}");
    assert_lan_port(&view, address.port());
    assert!(
        !lan_listeners(&view).contains(&address.to_string()),
        "{view}"
    );
    assert!(
        !view["lan_urls"]
            .as_array()
            .unwrap()
            .contains(&json!(format!("http://{address}")))
    );
    let error = view["bind_errors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|error| error["address"] == address.to_string())
        .expect("bind error");
    assert!(!error["error"].as_str().unwrap().is_empty(), "{view}");
    let bound = lan_listeners(&view);
    assert_eq!(app.set_remote(false).await?["bind_errors"], json!([]));
    for address in &bound {
        wait_unbound(address).await;
    }
    drop(occupied);
    let view = app.set_remote(true).await?;
    assert_eq!(view["bind_errors"], json!([]), "{view}");
    assert!(
        lan_listeners(&view).contains(&address.to_string()),
        "{view}"
    );
    let remote = Gateway::new(format!("http://{address}"), s.gw.token.clone());
    assert_eq!(remote.get("/health").await?.status, 200);
    app.set_remote(false).await?;
    s.finish().await
}
