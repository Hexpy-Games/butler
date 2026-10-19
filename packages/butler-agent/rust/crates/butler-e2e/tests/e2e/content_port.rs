//! Content origins follow the listener selected at startup.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    agent::Launch,
    gateway::Gateway,
    sandbox::Sandbox,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use serde_json::json;
use std::{
    io::Write,
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::JoinHandle,
};

struct Foreign {
    stop: Arc<AtomicBool>,
    hits: Arc<AtomicUsize>,
    task: Option<JoinHandle<()>>,
}
impl Foreign {
    fn bind(port: u16) -> Result<Self, HarnessError> {
        let listener = TcpListener::bind(("127.0.0.1", port))?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let hits = Arc::new(AtomicUsize::new(0));
        let (done, count) = (stop.clone(), hits.clone());
        let task = std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        count.fetch_add(1, Ordering::Relaxed);
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nsentinel");
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("foreign accept: {e}"),
                }
            }
        });
        Ok(Self {
            stop,
            hits,
            task: Some(task),
        })
    }
}
impl Drop for Foreign {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.task.take().unwrap().join().unwrap();
    }
}
fn admin(s: &Scenario) -> AdminClient {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
}
async fn setup(name: &str) -> Result<Scenario, HarnessError> {
    Setup::new(name)?
        .stub_cassette(super::browser_outputs::stub::cassette()?)
        .start()
        .await
}
async fn occupy(s: &mut Scenario) -> Result<Foreign, HarnessError> {
    s.agent.terminate().await?;
    let foreign = Foreign::bind(s.agent.launch.port + 1)?;
    s.gw = s.agent.start_again().await?;
    Ok(foreign)
}
async fn publish(s: &Scenario) -> Result<String, HarnessError> {
    s.turn("general", "Publish").await?;
    use sha2::{Digest, Sha256};
    Ok(format!(
        "/outputs/{:x}/view",
        Sha256::digest(b"general\0site")
    ))
}
async fn view(gw: &Gateway, path: &str) -> Result<reqwest::Url, HarnessError> {
    let reply = gw.get(path).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reqwest::Url::parse(reply.data()["url"].as_str().unwrap()).unwrap())
}
async fn content(
    url: &reqwest::Url,
    api_origin: &str,
    wrong_host: &str,
) -> Result<(), HarnessError> {
    let client = reqwest::Client::builder().no_proxy().build()?;
    let reply = client.get(url.clone()).send().await?;
    assert_eq!(reply.status(), 200);
    let csp = reply.headers()["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("frame-ancestors app://butler"), "{csp}");
    assert!(csp.contains(api_origin), "{csp}");
    let body = reply.text().await?;
    assert!(
        body.contains("<h1>Output</h1>") && body.contains("./app.js"),
        "{body}"
    );
    assert!(!body.contains("sentinel"));
    assert_eq!(
        client
            .get(url.clone())
            .header("host", wrong_host)
            .send()
            .await?
            .status(),
        403
    );
    Ok(())
}
#[tokio::test]
async fn foreign_listener_on_content_port() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("CONTENT-FALLBACK").await?;
    let foreign = occupy(&mut s).await?;
    let path = publish(&s).await?;
    let url = view(&s.gw, &path).await?;
    let p = s.agent.launch.port;
    let q = url.port().unwrap();
    assert_ne!(q, p);
    assert_ne!(q, p + 1);
    assert_eq!(
        url.origin().ascii_serialization(),
        format!("http://127.0.0.1:{q}")
    );
    assert_eq!(
        admin(&s).view().await?["content_addresses"][0],
        format!("127.0.0.1:{q}")
    );
    let ui =
        s.gw.http()
            .get(format!("{}/", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    assert_eq!(ui.status(), 200);
    let csp = ui.headers()["content-security-policy"].to_str().unwrap();
    let frames: Vec<_> = csp
        .split(';')
        .find_map(|directive| directive.trim().strip_prefix("frame-src "))
        .unwrap()
        .split_whitespace()
        .collect();
    assert!(
        frames.contains(&format!("http://127.0.0.1:{q}").as_str()),
        "{csp}"
    );
    assert!(
        frames.contains(&format!("http://localhost:{q}").as_str()),
        "{csp}"
    );
    assert!(
        !frames.contains(&format!("http://127.0.0.1:{}", p + 1).as_str()),
        "{csp}"
    );
    content(
        &url,
        &format!("http://127.0.0.1:{p}"),
        &format!("127.0.0.1:{}", p + 1),
    )
    .await?;
    assert_eq!(
        reqwest::get(format!("{}/health", url.origin().ascii_serialization()))
            .await?
            .status(),
        404
    );
    assert_eq!(s.gw.get(url.path()).await?.status, 404);
    assert_eq!(foreign.hits.load(Ordering::Relaxed), 0);
    s.finish().await
}
#[tokio::test]
async fn default_content_port_unchanged() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("CONTENT-DEFAULT").await?;
    let path = publish(&s).await?;
    let expected = format!("127.0.0.1:{}", s.agent.launch.port + 1);
    assert_eq!(
        view(&s.gw, &path).await?.origin().ascii_serialization(),
        format!("http://{expected}")
    );
    assert_eq!(
        admin(&s).view().await?["content_addresses"],
        json!([expected])
    );
    s.finish().await
}
#[tokio::test]
async fn lan_client_gets_actual_content_port() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("CONTENT-LAN").await?;
    let foreign = occupy(&mut s).await?;
    let path = publish(&s).await?;
    let security = admin(&s).set_remote(true).await?;
    let lan = security["bind_addresses"][1].as_str();
    if std::env::var_os("BUTLER_E2E_REQUIRE_LAN").is_some() {
        assert!(lan.is_some(), "{security}");
    }
    butler_e2e::skip_unless!(lan.is_some(), "no LAN listener");
    let address: std::net::SocketAddr = lan.unwrap().parse().unwrap();
    let remote = Gateway::new(format!("http://{address}"), s.gw.token.clone());
    let url = view(&remote, &path).await?;
    let q = view(&s.gw, &path).await?.port().unwrap();
    let content_address = std::net::SocketAddr::new(address.ip(), q);
    assert_eq!(
        url.origin().ascii_serialization(),
        format!("http://{content_address}")
    );
    assert!(
        security["content_addresses"]
            .as_array()
            .unwrap()
            .contains(&json!(content_address.to_string()))
    );
    content(
        &url,
        &format!("http://{address}"),
        &std::net::SocketAddr::new(address.ip(), address.port() + 1).to_string(),
    )
    .await?;
    assert_eq!(foreign.hits.load(Ordering::Relaxed), 0);
    s.finish().await
}
#[tokio::test]
async fn capability_bound_to_content_port() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("CONTENT-CAPABILITY").await?;
    let path = publish(&s).await?;
    let mut old = view(&s.gw, &path).await?;
    let foreign = occupy(&mut s).await?;
    let fresh = view(&s.gw, &path).await?;
    old.set_port(fresh.port()).unwrap();
    assert_eq!(reqwest::get(old).await?.status(), 403);
    assert_eq!(reqwest::get(fresh).await?.status(), 200);
    assert_eq!(foreign.hits.load(Ordering::Relaxed), 0);
    s.finish().await
}

#[tokio::test]
async fn permission_denied_content_port_falls_back() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let probe = TcpListener::bind("127.0.0.1:1");
    butler_e2e::skip_unless!(
        probe
            .as_ref()
            .is_err_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied),
        "OS permits the privileged port or refuses it for another reason"
    );
    eprintln!("privileged port probe: PermissionDenied; running fallback scenario");
    let s = Setup::new("CONTENT-PERMISSION")?
        .stub_cassette(super::browser_outputs::stub::cassette()?)
        .env("BUTLER_APP_CONTENT_PORT", "1")
        .start()
        .await?;
    let path = publish(&s).await?;
    let url = view(&s.gw, &path).await?;
    let addresses = admin(&s).view().await?;
    let address: std::net::SocketAddr = addresses["content_addresses"][0]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(address.ip(), std::net::Ipv4Addr::LOCALHOST);
    assert_ne!(address.port(), 1);
    assert_eq!(
        url.origin().ascii_serialization(),
        format!("http://{address}")
    );
    content(&url, &s.gw.base, "127.0.0.1:1").await?;
    s.finish().await
}

#[tokio::test]
async fn invalid_content_port_rejects_startup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_startup_rejected(
        Setup::new("CONTENT-INVALID")?.env("BUTLER_APP_CONTENT_PORT", "abc"),
        "BUTLER_APP_CONTENT_PORT",
    )
    .await
}

#[tokio::test]
async fn trusted_dev_origin_rejects_content_port() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut reservation = Sandbox::new("CONTENT-ORIGIN-PORT")?;
    let reserved = Launch::new(&reservation)?;
    let port = reserved.port;
    let origin = format!("http://localhost:{port}");
    assert_startup_rejected(
        Setup::new("CONTENT-ORIGIN")?
            .env("BUTLER_APP_DEV_ORIGIN", &origin)
            .env("BUTLER_APP_CONTENT_PORT", port.to_string()),
        &format!("content port must use a separate origin from {origin}"),
    )
    .await?;
    reservation.mark_success();
    Ok(())
}

async fn assert_startup_rejected(setup: Setup, expected: &str) -> Result<(), HarnessError> {
    match setup
        .stub_cassette(super::browser_outputs::stub::cassette()?)
        .start()
        .await
    {
        Ok(scenario) => {
            scenario.finish().await?;
            panic!("startup accepted invalid content configuration");
        }
        Err(error) => {
            let message = error.0;
            assert!(message.starts_with("agent exited ("), "{message}");
            assert!(message.contains(expected), "{message}");
        }
    }
    Ok(())
}
