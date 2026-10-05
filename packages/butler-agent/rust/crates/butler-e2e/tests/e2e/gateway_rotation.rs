//! SEC. Settings → Security (#229): the connection code (the gateway token)
//! can be shown and rotated by the App or the CLI on this computer, and a
//! browser on another computer signs in with it on the connection page.
//! Rotation replaces the data-folder token file, and at once the old code,
//! its signed URLs, browser sessions and live streams stop working, while
//! the CLI and a restarted agent use the new code. The admin credential
//! stays.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::media;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::security::AdminClient;
use reqwest::Method;

const ROTATED: &str = "security.connection_code_rotated";

fn url(gw: &Gateway, path: &str) -> String {
    format!("{}{path}", gw.base)
}

/// A client that does not follow redirects, so the cookie hand-off is seen.
fn browser() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

/// Redeems a `butler open` link; the `name=value` session cookie.
async fn session_cookie(s: &Scenario, browser: &reqwest::Client) -> Result<String, HarnessError> {
    let open = s.agent.cli(&["open", "--no-browser", "--json"])?;
    assert_eq!(open.code, Some(0), "{open:?}");
    let link = open.json()?["data"]["url"].as_str().unwrap().to_owned();
    let redeemed = browser.get(&link).send().await?;
    assert_eq!(redeemed.status().as_u16(), 303);
    Ok(cookie_pair(redeemed.headers()))
}

/// Types `code` into the connection page's form, as a browser on another
/// computer does; the reply.
async fn connect_form(
    gw: &Gateway,
    browser: &reqwest::Client,
    code: &str,
) -> Result<reqwest::Response, HarnessError> {
    Ok(browser
        .post(url(gw, "/connect"))
        .header("origin", gw.base.as_str())
        .form(&[("code", code)])
        .send()
        .await?)
}

fn cookie_pair(headers: &reqwest::header::HeaderMap) -> String {
    let set_cookie = headers.get("set-cookie").unwrap().to_str().unwrap();
    set_cookie.split(';').next().unwrap().to_owned()
}

/// `GET /settings` as the Butler page with `cookie`; the status.
async fn page_read(
    gw: &Gateway,
    browser: &reqwest::Client,
    cookie: &str,
) -> Result<u16, HarnessError> {
    let response = browser
        .get(url(gw, "/settings"))
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await?;
    Ok(response.status().as_u16())
}

async fn status(gw: &Gateway, path: &str, token: &str) -> Result<u16, HarnessError> {
    Ok(gw
        .send_with(Method::GET, path, None, Some(token), &[])
        .await?
        .status)
}

/// SEC-10 — rotating the connection code: the reply carries the new code,
/// the token file holds it, the old code gets 401, its signed file URL,
/// browser sessions (from `butler open` and from the code typed on the
/// connection page) and live stream stop working (the stream first gets
/// `security.connection_code_rotated`), and `butler open` and a restarted
/// agent use the new code. The admin credential does not change. A browser
/// session that rotates gets a cookie under the new code.
#[tokio::test]
async fn sec_10_rotation_revokes_the_old_code_everywhere() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-10")?.data_folder_token().start().await?;
    let admin = s.agent.launch.admin_credential().unwrap();
    let app = AdminClient::new(s.gw.clone(), admin.clone());
    let old = s.gw.token.clone();
    let revealed = app
        .send(Method::POST, "/security/connection-code/reveal", None, &[])
        .await?;
    assert_eq!(revealed.status, 404);

    let upload =
        s.gw.upload(
            "number.png",
            "image/png",
            &media::digits_png("73", 8),
            Some("general"),
        )
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let signed = upload.data()["file"]["signed_url"]
        .as_str()
        .unwrap()
        .to_owned();
    let browser = browser();
    assert_eq!(
        browser
            .get(url(&s.gw, &signed))
            .send()
            .await?
            .status()
            .as_u16(),
        200
    );
    let cookie = session_cookie(&s, &browser).await?;
    assert_eq!(page_read(&s.gw, &browser, &cookie).await?, 200);
    let pin = app
        .send(Method::POST, "/security/pairing", None, &[])
        .await?;
    let typed =
        connect_code_signs_in(&s.gw, &browser, pin.data()["code"].as_str().unwrap()).await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let rotated = app.rotate().await?;
    let new = rotated["code"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    assert!(new.len() >= 32, "short code");
    assert!(rotated["created_at"].is_string(), "{rotated}");
    assert_eq!(
        s.agent.launch.data_folder_token().as_deref(),
        Some(new.as_str())
    );
    assert_eq!(
        s.agent.launch.admin_credential(),
        Some(admin.clone()),
        "admin rotated"
    );

    let notice = stream
        .wait_for(Duration::from_secs(10), |event| event["type"] == ROTATED)
        .await?;
    assert!(
        !notice.to_string().contains(&new) && !notice.to_string().contains(&old),
        "rotation event leaks a code: {notice}"
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !stream.is_closed() {
        assert!(Instant::now() < deadline, "old live stream still open");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    for path in ["/settings", "/events/live"] {
        assert_eq!(status(&s.gw, path, &old).await?, 401, "old code on {path}");
    }
    assert_eq!(status(&s.gw, "/settings", &new).await?, 200);
    assert_eq!(
        browser
            .get(url(&s.gw, &signed))
            .send()
            .await?
            .status()
            .as_u16(),
        401,
        "old signed URL"
    );
    assert_eq!(
        page_read(&s.gw, &browser, &cookie).await?,
        401,
        "old session"
    );
    assert_eq!(
        page_read(&s.gw, &browser, &typed).await?,
        401,
        "old typed session"
    );
    let stale = connect_form(&s.gw, &browser, &old).await?;
    assert_eq!(stale.status().as_u16(), 401, "old code signed in");

    s.gw = Gateway::new(s.gw.base.clone(), new.clone());
    s.agent.launch.token = new.clone();
    let app = AdminClient::new(s.gw.clone(), admin);
    let view = app.view().await?;
    assert!(view["connection_code"].is_null());
    let open = s.agent.cli(&["open", "--no-browser", "--json"])?;
    assert_eq!(open.code, Some(0), "butler open after rotation: {open:?}");

    let current = app.rotate().await?["code"].as_str().unwrap().to_owned();
    assert_eq!(s.agent.launch.data_folder_token(), Some(current.clone()));
    s.agent.launch.token = current.clone();
    s.restart().await?;
    assert_eq!(
        status(&s.gw, "/settings", &current).await?,
        200,
        "after restart"
    );
    assert_eq!(
        status(&s.gw, "/settings", &new).await?,
        401,
        "after restart"
    );
    s.finish().await
}

/// The connection page (for a browser on another computer) asks for the
/// code from Settings → Security; the code typed there signs in, a wrong
/// one does not. Returns the session cookie.
async fn connect_code_signs_in(
    gw: &Gateway,
    browser: &reqwest::Client,
    code: &str,
) -> Result<String, HarnessError> {
    let page = browser
        .get(url(gw, "/connect"))
        .send()
        .await?
        .text()
        .await?;
    assert!(page.contains("butler remote pair"), "{page}");
    assert!(page.contains(r#"method="post""#), "{page}");
    let wrong = connect_form(gw, browser, "not-the-code").await?;
    assert_eq!(wrong.status().as_u16(), 401);
    assert!(wrong.headers().get("set-cookie").is_none());
    let signed_in = connect_form(gw, browser, code).await?;
    assert_eq!(signed_in.status().as_u16(), 303);
    let cookie = cookie_pair(signed_in.headers());
    assert_eq!(page_read(gw, browser, &cookie).await?, 200);
    Ok(cookie)
}
