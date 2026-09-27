//! SEC. Local gateway security model (#228): a data-folder token enforced
//! however the agent started, Host/Origin admission, CORS for the
//! `app://butler` renderer, signed short-lived URLs for token-less
//! subresources, and `butler open`'s one-time browser link.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::DATA_FOLDER_TOKEN_FILE;
use butler_e2e::e2e::gateway::Gateway;
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

/// A client that does not follow redirects, so the cookie hand-off is seen.
fn browser() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn file_mode(path: &std::path::Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
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
    assert_eq!(file_mode(&token_file), 0o600, "token file not private");
    let secret = s
        .sandbox
        .data
        .join("state/app-gateway/project-folder-token-secret");
    assert!(!std::fs::read_to_string(&secret)?.trim().is_empty());
    assert_eq!(file_mode(&secret), 0o600, "folder secret not private");

    for token in [None, Some("wrong-token")] {
        let reply =
            s.gw.send_with(Method::GET, "/settings", None, token, &[])
                .await?;
        assert_eq!(reply.status, 401, "{token:?}: {}", reply.text);
        assert_eq!(reply.error_code(), Some("local_auth_required"));
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

/// SEC-04 — `<img>` and the artifact viewer send no Authorization header:
/// the plain file URL answers 401, the `signed_url` the gateway returns
/// serves that one file without a token until it expires, and a signature
/// opens nothing else.
#[tokio::test]
async fn sec_04_signed_file_url_works_once_and_expires() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-04")?
        .env("BUTLER_APP_SIGNED_URL_TTL_SECONDS", "3")
        .start()
        .await?;
    let png = media::digits_png("4821", 12);
    let upload =
        s.gw.upload("number.png", "image/png", &png, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file = &upload.data()["file"];
    let plain = file["url"].as_str().unwrap();
    let signed = file["signed_url"]
        .as_str()
        .expect("no signed_url")
        .to_owned();
    assert!(signed.starts_with(&format!("{plain}?expires=")), "{signed}");
    assert!(signed.contains("&signature="), "{signed}");

    let tokenless = s.gw.http().get(url(&s.gw, plain)).send().await?;
    assert_eq!(
        tokenless.status().as_u16(),
        401,
        "plain file URL served without a token"
    );
    let served = s.gw.http().get(url(&s.gw, &signed)).send().await?;
    assert_eq!(served.status().as_u16(), 200);
    assert_eq!(header(served.headers(), "content-type"), "image/png");
    assert_eq!(served.bytes().await?.to_vec(), png);

    let query = signed.split_once('?').unwrap().1;
    let tampered = format!("{signed}x");
    for (label, target) in [
        ("tampered", tampered),
        ("other route", format!("/settings?{query}")),
        ("events", format!("/events?{query}")),
    ] {
        let reply = s.gw.http().get(url(&s.gw, &target)).send().await?;
        assert_eq!(reply.status().as_u16(), 401, "{label} accepted");
    }

    tokio::time::sleep(Duration::from_millis(4_500)).await;
    let expired = s.gw.http().get(url(&s.gw, &signed)).send().await?;
    assert_eq!(expired.status().as_u16(), 401, "expired signature accepted");
    s.finish().await
}

/// Runs `butler open --no-browser --json` and returns `(url, code)`.
fn open_link(s: &Scenario) -> Result<(String, String), HarnessError> {
    let output = s.agent.cli(&["open", "--no-browser", "--json"])?;
    assert_eq!(output.code, Some(0), "{output:?}");
    let value = output.json()?;
    assert_eq!(value["data"]["browserOpened"], false, "{value}");
    Ok((
        value["data"]["url"].as_str().unwrap().to_owned(),
        value["data"]["code"].as_str().unwrap().to_owned(),
    ))
}

/// SEC-05 — `butler open`: the one-time link sets an HttpOnly, SameSite=Strict
/// session cookie and cannot be used twice; a browser without it gets the
/// connection-code screen (no password dialog); cookie requests that change
/// state must come from the Butler page.
#[tokio::test]
async fn sec_05_one_time_link_sets_a_cookie_and_cannot_be_reused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-05")?.start().await?;
    let browser = browser();
    let page = browser
        .get(url(&s.gw, "/"))
        .header("accept", "text/html")
        .send()
        .await?;
    assert_eq!(page.status().as_u16(), 401);
    assert!(
        page.headers().get("www-authenticate").is_none(),
        "password dialog"
    );
    assert!(page.text().await?.contains("Connection code"));

    let (link, _) = open_link(&s)?;
    assert!(
        link.starts_with(&format!("{}/connect?code=", s.gw.base)),
        "{link}"
    );
    let redeemed = browser.get(&link).send().await?;
    assert_eq!(redeemed.status().as_u16(), 303);
    assert_eq!(header(redeemed.headers(), "location"), "/");
    let set_cookie = header(redeemed.headers(), "set-cookie").to_owned();
    assert!(
        set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"),
        "{set_cookie}"
    );
    let cookie = set_cookie.split(';').next().unwrap().to_owned();
    let reused = browser.get(&link).send().await?;
    assert_eq!(reused.status().as_u16(), 401, "link reused");
    assert!(reused.headers().get("set-cookie").is_none());
    assert_cookie_session(&s.gw, &browser, &cookie).await?;

    let (_, code) = open_link(&s)?;
    let typed = code.to_lowercase().replace('-', " ");
    let entered = browser
        .get(url(&s.gw, "/connect"))
        .query(&[("code", typed)])
        .send()
        .await?;
    assert_eq!(
        entered.status().as_u16(),
        303,
        "typed connection code refused"
    );
    s.finish().await
}

/// SEC-05: the session cookie reads without a token; a state change with it
/// needs the page's own Origin; it cannot mint further codes.
async fn assert_cookie_session(
    gw: &Gateway,
    browser: &reqwest::Client,
    cookie: &str,
) -> Result<(), HarnessError> {
    let settings = browser
        .get(url(gw, "/settings"))
        .header("cookie", cookie)
        .send()
        .await?;
    assert_eq!(settings.status().as_u16(), 200);
    let own_origin = gw.base.as_str();
    let body = json!({"language": "ko"}).to_string();
    for (origin, expected) in [(None, 403), (Some(own_origin), 200)] {
        let mut request = browser
            .patch(url(gw, "/settings"))
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(body.clone());
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let status = request.send().await?.status().as_u16();
        assert_eq!(status, expected, "origin {origin:?}");
    }
    let minted = browser
        .post(url(gw, "/connection-codes"))
        .header("cookie", cookie)
        .header("origin", own_origin)
        .send()
        .await?;
    assert_eq!(minted.status().as_u16(), 403, "a session minted a code");
    Ok(())
}
