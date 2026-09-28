//! SEC. Settings → Security (#229): the connection code (the gateway token)
//! can be shown and rotated from this computer. Rotation replaces the
//! data-folder token file, and at once the old code, its signed URLs,
//! browser sessions and live streams stop working, while the CLI and a
//! restarted agent use the new code.
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
use reqwest::Method;
use serde_json::{Value, json};

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
/// browser session and live stream stop working (the stream first gets
/// `security.connection_code_rotated`), and `butler open` and a restarted
/// agent use the new code. A browser session that rotates gets a cookie
/// under the new code.
#[tokio::test]
async fn sec_10_rotation_revokes_the_old_code_everywhere() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-10")?.data_folder_token().start().await?;
    let old = s.gw.token.clone();
    let revealed =
        s.gw.post("/security/connection-code/reveal", json!({}))
            .await?;
    assert_eq!(revealed.status, 200, "{}", revealed.text);
    assert_eq!(revealed.data()["code"], old.as_str());

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
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let rotated =
        s.gw.post("/security/connection-code/rotate", json!({}))
            .await?;
    assert_eq!(rotated.status, 200, "{}", rotated.text);
    let new = rotated.data()["code"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    assert!(new.len() >= 32, "short code");
    assert!(rotated.data()["created_at"].is_string(), "{}", rotated.text);
    assert_eq!(
        s.agent.launch.data_folder_token().as_deref(),
        Some(new.as_str())
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

    for path in ["/settings", "/events/live", "/security"] {
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

    s.gw = Gateway::new(s.gw.base.clone(), new.clone());
    s.agent.launch.token = new.clone();
    let view = s.gw.get("/security").await?;
    let masked = format!("{}…{}", &new[..4], &new[new.len() - 4..]);
    assert_eq!(
        view.data()["connection_code"]["masked"],
        masked,
        "{}",
        view.text
    );
    let open = s.agent.cli(&["open", "--no-browser", "--json"])?;
    assert_eq!(open.code, Some(0), "butler open after rotation: {open:?}");

    let current = rotate_as_browser_page(&s, &browser).await?;
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

/// The Butler page in a local browser rotates with its session cookie and
/// keeps working with the cookie the reply sets; the old cookie does not.
/// Returns the new code.
async fn rotate_as_browser_page(
    s: &Scenario,
    browser: &reqwest::Client,
) -> Result<String, HarnessError> {
    let cookie = session_cookie(s, browser).await?;
    let own_origin = s.gw.base.as_str();
    let rotated = browser
        .post(url(&s.gw, "/security/connection-code/rotate"))
        .header("cookie", &cookie)
        .header("sec-fetch-site", "same-origin")
        .header("origin", own_origin)
        .send()
        .await?;
    assert_eq!(rotated.status().as_u16(), 200);
    let renewed = cookie_pair(rotated.headers());
    let body: Value = rotated.json().await?;
    let code = body["data"]["code"].as_str().unwrap().to_owned();
    assert_eq!(
        page_read(&s.gw, browser, &renewed).await?,
        200,
        "renewed session"
    );
    assert_eq!(
        page_read(&s.gw, browser, &cookie).await?,
        401,
        "old session"
    );
    assert_eq!(status(&s.gw, "/settings", &code).await?, 200);
    Ok(code)
}
