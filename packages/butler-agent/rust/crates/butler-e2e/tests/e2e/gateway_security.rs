//! SEC. Local gateway security model (#228): a data-folder token enforced
//! however the agent started (and kept when the App adopts it), Host/Origin
//! admission, CORS for the `app://butler` renderer, and a fail-closed
//! gateway that says why its token is unavailable. Browser access (signed
//! URLs, `butler open`, message files) is in `gateway_browser.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs::File;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::{DATA_FOLDER_TOKEN_FILE, Launch};
use butler_e2e::e2e::gateway::{Gateway, Reply};
use butler_e2e::e2e::media;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use reqwest::Method;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};

const APP_ORIGIN: &str = "app://butler";

fn url(gw: &Gateway, path: &str) -> String {
    format!("{}{path}", gw.base)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

/// Whether the file is private to the user. A host without owner-only
/// permissions (Windows, until the data-folder ACL) cannot restrict it, so
/// there the check is that it at least exists.
fn is_private(path: &std::path::Path) -> bool {
    let metadata = std::fs::metadata(path).unwrap();
    match butler_platform::secure_fs::is_owner_only(&metadata) {
        Some(private) => private,
        None => !butler_platform::secure_fs::OWNER_ONLY && metadata.is_file(),
    }
}

/// SEC-01 — an agent started without token variables (as `butler start`
/// runs it) creates the token and the folder secret in its data folder,
/// private to the user, enforces the token, keeps it across restarts, and
/// its CLI reads the same file.
#[tokio::test]
async fn sec_01_cli_started_agent_owns_and_enforces_its_token() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-01")?.data_folder_token().start().await?;
    let token_file = s.sandbox.data.join(DATA_FOLDER_TOKEN_FILE);
    let stored: Value = serde_json::from_slice(&std::fs::read(&token_file)?)?;
    assert_eq!(
        stored["schema"], "butler.app-local-agent-auth.v1",
        "{stored}"
    );
    let token = stored["token"].as_str().unwrap().to_owned();
    assert!(token.len() >= 32, "short token");
    assert_eq!(token, s.gw.token);
    assert!(is_private(&token_file), "token file not private");
    let secret = s
        .sandbox
        .data
        .join("state/app-gateway/project-folder-token-secret");
    assert!(!std::fs::read_to_string(&secret)?.trim().is_empty());
    assert!(is_private(&secret), "folder secret not private");

    // An API path ending in an asset extension is not a public asset.
    for path in ["/settings", "/sessions/general.json"] {
        for token in [None, Some("wrong-token")] {
            let reply = s.gw.send_with(Method::GET, path, None, token, &[]).await?;
            assert_eq!(reply.status, 401, "{path} {token:?}: {}", reply.text);
            assert_eq!(reply.error_code(), Some("local_auth_required"));
        }
    }
    assert_eq!(s.gw.get("/settings").await?.status, 200);

    s.restart().await?;
    assert_eq!(
        s.agent.launch.data_folder_token().as_deref(),
        Some(token.as_str()),
        "token changed across a restart"
    );
    assert_eq!(s.gw.get("/settings").await?.status, 200);

    let open = s.agent.cli(&["open", "--no-browser", "--json"])?;
    assert_eq!(open.code, Some(0), "{open:?}");
    assert_eq!(open.json()?["ok"], true, "{open:?}");
    s.finish().await
}

/// SEC-02 — DNS rebinding and cross-site requests are refused even with
/// the token: a foreign Host, a foreign Origin and `Origin: null`. Requests
/// without Origin (the current `file://` App, the CLI) keep working, and a
/// request body must be JSON.
#[tokio::test]
async fn sec_02_foreign_host_and_origin_are_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-02")?.start().await?;
    let port = s.agent.launch.port;
    let before = s.gw.get("/settings").await?.text;
    let foreign_host = format!("attacker.example:{port}");
    let reply =
        s.gw.send_with(
            Method::GET,
            "/settings",
            None,
            Some(&s.gw.token),
            &[("host", &foreign_host)],
        )
        .await?;
    assert_eq!(reply.status, 403, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("host_not_allowed"));
    let loopback_host = format!("localhost:{port}");
    let reply =
        s.gw.send_with(
            Method::GET,
            "/settings",
            None,
            Some(&s.gw.token),
            &[("host", &loopback_host)],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);

    for origin in ["https://evil.example", "null", "http://localhost:5173"] {
        for (method, path, body) in [
            (Method::GET, "/settings", None),
            (
                Method::PATCH,
                "/settings",
                Some(json!({"language": "ko"}).to_string()),
            ),
        ] {
            let response =
                s.gw.http()
                    .request(method.clone(), url(&s.gw, path))
                    .bearer_auth(&s.gw.token)
                    .header("origin", origin)
                    .header("content-type", "application/json")
                    .body(body.unwrap_or_default())
                    .send()
                    .await?;
            assert_eq!(response.status().as_u16(), 403, "{origin} {method} {path}");
            assert!(
                response
                    .headers()
                    .get("access-control-allow-origin")
                    .is_none(),
                "{origin} echoed"
            );
        }
    }

    let plain =
        s.gw.http()
            .post(url(&s.gw, "/messages"))
            .bearer_auth(&s.gw.token)
            .header("content-type", "text/plain")
            .body(json!({"text": "hi"}).to_string())
            .send()
            .await?;
    assert_eq!(plain.status().as_u16(), 415);
    assert_eq!(
        s.gw.get("/settings").await?.text,
        before,
        "refused call changed state"
    );
    assert!(s.gw.messages("general").await?.is_empty());
    s.finish().await
}

/// SEC-03 — the `app://butler` renderer: preflight is answered before auth,
/// and every answer (JSON, the live-events stream, message files) echoes
/// the origin with `Vary: Origin`.
#[tokio::test]
async fn sec_03_app_origin_preflight_and_requests_succeed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-03")?.start().await?;
    let preflight =
        s.gw.http()
            .request(Method::OPTIONS, url(&s.gw, "/settings"))
            .header("origin", APP_ORIGIN)
            .header("access-control-request-method", "PATCH")
            .header(
                "access-control-request-headers",
                "authorization,content-type",
            )
            .send()
            .await?;
    assert_eq!(preflight.status().as_u16(), 204);
    assert_app_cors(&preflight, "preflight");
    let headers = preflight.headers();
    assert!(header(headers, "access-control-allow-methods").contains("PATCH"));
    assert!(header(headers, "access-control-allow-headers").contains("authorization"));

    let patch = from_app(&s.gw, Method::PATCH, "/settings")
        .header("content-type", "application/json")
        .body(json!({"language": "ko"}).to_string())
        .send()
        .await?;
    assert_eq!(patch.status().as_u16(), 200);
    assert_app_cors(&patch, "PATCH /settings");

    let (content_type, body) = media::multipart_file(
        "number.png",
        "image/png",
        &media::digits_png("73", 8),
        Some("general"),
    );
    let upload = from_app(&s.gw, Method::POST, "/message-files")
        .header("content-type", content_type)
        .body(body)
        .send()
        .await?;
    assert_eq!(upload.status().as_u16(), 201);
    assert_app_cors(&upload, "upload");
    let file: Value = upload.json().await?;
    let file_url = file["data"]["file"]["url"].as_str().unwrap().to_owned();
    let download = from_app(&s.gw, Method::GET, &file_url).send().await?;
    assert_eq!(download.status().as_u16(), 200);
    assert_app_cors(&download, "message file");

    let live = from_app(&s.gw, Method::GET, "/events/live?cursor=0")
        .header("accept", "text/event-stream")
        .send()
        .await?;
    assert_eq!(live.status().as_u16(), 200);
    assert_app_cors(&live, "live events");
    drop(live);
    s.finish().await
}

/// A request from the `app://butler` renderer, token in the header.
fn from_app(gw: &Gateway, method: Method, path: &str) -> reqwest::RequestBuilder {
    gw.http()
        .request(method, url(gw, path))
        .bearer_auth(&gw.token)
        .header("origin", APP_ORIGIN)
}

fn assert_app_cors(response: &reqwest::Response, what: &str) {
    let headers = response.headers();
    assert_eq!(
        header(headers, "access-control-allow-origin"),
        APP_ORIGIN,
        "{what}"
    );
    assert!(header(headers, "vary").contains("Origin"), "{what}");
}

/// SEC-06 — the App adopts an agent the CLI started, then the agent it
/// launches itself: the CLI-started agent created the data folder's token;
/// the App reads that file (as its `prepareAppLocalAuth` does), connects,
/// and replaces the process with one started with
/// `BUTLER_APP_LOCAL_AUTH_FILE` naming the same file. One token and one
/// state across the launches; `butler open` works under both.
#[tokio::test]
async fn sec_06_app_reconnects_to_a_cli_started_agent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-06")?.data_folder_token().start().await?;
    let token_file = s.sandbox.data.join(DATA_FOLDER_TOKEN_FILE);
    let written = std::fs::read(&token_file)?;
    let app_token = s.agent.launch.data_folder_token().unwrap();
    let app = Gateway::new(s.gw.base.clone(), app_token.clone());
    let patch = from_app(&app, Method::PATCH, "/settings")
        .header("content-type", "application/json")
        .body(json!({"language": "ko"}).to_string())
        .send()
        .await?;
    assert_eq!(patch.status().as_u16(), 200, "App refused by the CLI agent");
    let png = media::digits_png("306", 8);
    let upload = app
        .upload("number.png", "image/png", &png, Some("general"))
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file = upload.data()["file"]["url"].as_str().unwrap().to_owned();

    let launch = &mut s.agent.launch;
    launch.set_env("BUTLER_APP_LOCAL_AUTH_REQUIRED", "1");
    launch.set_env(
        "BUTLER_APP_LOCAL_AUTH_FILE",
        token_file.display().to_string(),
    );
    launch.set_env("BUTLER_APP_BUNDLED_SUPERVISOR", "1");
    s.restart().await?;
    assert_eq!(std::fs::read(&token_file)?, written, "token file rewritten");
    assert_app_session(&s, &app, &file, &png).await?;

    // And back to a CLI start: still the same token.
    s.agent.launch.use_data_folder_token();
    s.agent.launch.remove_env("BUTLER_APP_BUNDLED_SUPERVISOR");
    s.restart().await?;
    assert_eq!(s.gw.token, app_token, "token changed on the CLI restart");
    assert_app_session(&s, &app, &file, &png).await?;
    s.finish().await
}

/// SEC-06: the App's client works against the running agent with the state
/// it left, a stale token does not, and `butler open` mints a link.
async fn assert_app_session(
    s: &Scenario,
    app: &Gateway,
    file: &str,
    png: &[u8],
) -> Result<(), HarnessError> {
    assert_eq!(s.gw.token, app.token);
    assert_eq!(app.settings().await?["language"], "ko");
    assert_eq!(app.download(file).await?, (200, png.to_vec()));
    let stale = app
        .send_with(Method::GET, "/settings", None, Some("e2e-stale-token"), &[])
        .await?;
    assert_eq!(stale.status, 401, "{}", stale.text);
    let open = s.agent.cli(&["open", "--no-browser", "--json"])?;
    assert_eq!(open.code, Some(0), "{open:?}");
    assert_eq!(open.json()?["ok"], true, "{open:?}");
    Ok(())
}

/// Kills an agent process the test spawned itself, also on a failed assertion.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// SEC-08 — a token file the agent cannot read fails closed and says why:
/// the gateway answers every client 503 `local_auth_unconfigured`, the
/// service log names the error code and the file (and never calls the
/// gateway ready), and `butler gateway status` reports it `unconfigured`
/// with the log and a service restart as next steps, not `offline` with a
/// start that would change nothing.
#[tokio::test]
async fn sec_08_unreadable_token_fails_closed_with_a_diagnostic() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-08")?.start().await?;
    s.agent.terminate().await?;
    let missing = s.sandbox.root.join("missing-gateway-auth.json");
    let mut launch = s.agent.launch.clone();
    launch.set_env("BUTLER_APP_LOCAL_AUTH_FILE", missing.display().to_string());
    let log = launch.logs.join("unreadable-token.log");
    let output = File::create(&log)?;
    let child = launch
        .command()
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output)
        .spawn()?;
    let mut agent = KillOnDrop(child);
    let reply = first_reply(&s.gw, &mut agent).await?;
    assert_eq!(reply.status, 503, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("local_auth_unconfigured"));
    let logged = std::fs::read_to_string(&log)?;
    let diagnostic = format!(
        "[native-app] local auth unavailable code=local_credential_unreadable path={}",
        missing.display()
    );
    assert!(logged.contains(&diagnostic), "{logged}");
    let view = service_gateway_status(&launch, &mut agent).await?;
    assert_eq!(view["status"], "unconfigured", "{view}");
    assert_eq!(view["running"], false, "{view}");
    assert_eq!(
        view["nextActions"],
        json!(["butler gateway logs app", "butler restart"]),
        "{view}"
    );
    let logged = std::fs::read_to_string(&log)?;
    assert!(
        logged.contains("[native-app] refusing clients address=")
            && logged.contains("code=local_auth_unconfigured"),
        "{logged}"
    );
    assert!(!logged.contains("[native-app] ready"), "{logged}");
    drop(agent);
    s.finish().await
}

/// `butler gateway status app --json` as the running service answers it;
/// until the service is ready the CLI reports its own `offline` view.
async fn service_gateway_status(
    launch: &Launch,
    agent: &mut KillOnDrop,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let output = tokio::process::Command::from(launch.command())
            .args(["gateway", "status", "app", "--json"])
            .stdin(Stdio::null())
            .output()
            .await?;
        let view = serde_json::from_slice::<Value>(&output.stdout)
            .ok()
            .map(|reply| reply["data"].clone());
        if let Some(view) = view.filter(|view| view["status"] != "offline") {
            return Ok(view);
        }
        if let Some(status) = agent.0.try_wait()? {
            panic!("agent exited ({status}) before its service answered");
        }
        assert!(
            Instant::now() < deadline,
            "no service answer to `gateway status` within 60s: {output:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The gateway's first answer to `GET /health`, whatever its status.
async fn first_reply(gw: &Gateway, agent: &mut KillOnDrop) -> Result<Reply, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let reply = gw
            .send_with(Method::GET, "/health", None, Some(&gw.token), &[])
            .await;
        if let Ok(reply) = reply {
            return Ok(reply);
        }
        if let Some(status) = agent.0.try_wait()? {
            panic!("agent exited ({status}) before its gateway answered");
        }
        assert!(Instant::now() < deadline, "no gateway answer within 90s");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
