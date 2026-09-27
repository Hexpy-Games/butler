//! SEC. Browser access to the local gateway (#228): signed short-lived URLs
//! for token-less subresources, `butler open`'s one-time link and the
//! session cookie it sets, which only the Butler page itself may use, and
//! message files that never run as pages of the gateway origin.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::media;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use reqwest::header::HeaderMap;
use serde_json::json;

/// The policy every message file except a PDF is served under.
const SANDBOXED_FILE_POLICY: &str = "sandbox; default-src 'none'";

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

/// SEC-04 — `<img>` and the artifact viewer send no Authorization header:
/// the plain file URL answers 401, and the `signed_url` the gateway returns
/// serves that one file without a token, as often as asked, until it
/// expires. The signature opens no other file and no API route.
#[tokio::test]
async fn sec_04_signed_file_url_serves_only_its_file_until_it_expires() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = Setup::new("SEC-04")?
        .env("BUTLER_APP_SIGNED_URL_TTL_SECONDS", "3")
        .start()
        .await?;
    let other =
        s.gw.upload(
            "other.png",
            "image/png",
            &media::digits_png("17", 12),
            Some("general"),
        )
        .await?;
    assert_eq!(other.status, 201, "{}", other.text);
    let other_file = other.data()["file"]["url"].as_str().unwrap().to_owned();
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
    for attempt in ["first", "again"] {
        let served = s.gw.http().get(url(&s.gw, &signed)).send().await?;
        assert_eq!(served.status().as_u16(), 200, "{attempt}");
        assert_eq!(header(served.headers(), "content-type"), "image/png");
        assert_eq!(served.bytes().await?.to_vec(), png, "{attempt}");
    }

    let query = signed.split_once('?').unwrap().1;
    for (label, target) in [
        ("tampered", format!("{signed}x")),
        ("other file", format!("{other_file}?{query}")),
        ("API route", format!("/settings?{query}")),
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
    assert_eq!(value["ok"], true, "{value}");
    assert_eq!(value["data"]["browserOpened"], false, "{value}");
    assert!(value["data"]["expiresAt"].is_string(), "{value}");
    assert_eq!(value["privacy"]["secretsIncluded"], true, "{value}");
    Ok((
        value["data"]["url"].as_str().unwrap().to_owned(),
        value["data"]["code"].as_str().unwrap().to_owned(),
    ))
}

/// Redeems a fresh one-time link; the `name=value` session cookie.
async fn session_cookie(s: &Scenario, browser: &reqwest::Client) -> Result<String, HarnessError> {
    let (link, _) = open_link(s)?;
    let redeemed = browser.get(&link).send().await?;
    assert_eq!(redeemed.status().as_u16(), 303);
    let set_cookie = header(redeemed.headers(), "set-cookie");
    Ok(set_cookie.split(';').next().unwrap().to_owned())
}

/// SEC-05 — `butler open`: the one-time link sets an HttpOnly, SameSite=Strict
/// session cookie and cannot be used twice; a browser without it gets the
/// connection-code screen (no password dialog); only the Butler page itself
/// may use the cookie.
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
    assert_cookie_reads(&s.gw, &browser, &cookie).await?;
    assert_cookie_writes(&s.gw, &browser, &cookie).await?;

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

/// Request headers as `(name, value)` pairs.
type Headers<'a> = &'a [(&'a str, &'a str)];

/// SEC-05: the cookie reads without a token from the Butler page
/// (`Sec-Fetch-Site: same-origin`) and a navigation the user started
/// (`none`). Another port of this host (`same-site`) or another site is
/// refused, and so is a loopback request with neither Fetch Metadata nor
/// the page's Origin.
async fn assert_cookie_reads(
    gw: &Gateway,
    browser: &reqwest::Client,
    cookie: &str,
) -> Result<(), HarnessError> {
    let own_origin = gw.base.as_str();
    // Request headers, expected status, expected error code.
    let cases: [(Headers<'_>, u16, Option<&str>); 7] = [
        (&[("sec-fetch-site", "same-origin")], 200, None),
        (&[("sec-fetch-site", "none")], 200, None),
        (&[("origin", own_origin)], 200, None),
        (
            &[("sec-fetch-site", "same-site")],
            403,
            Some("cross_site_session"),
        ),
        (
            &[("sec-fetch-site", "cross-site")],
            403,
            Some("cross_site_session"),
        ),
        (&[], 403, Some("origin_required")),
        (
            &[("sec-fetch-site", "same-site"), ("origin", own_origin)],
            403,
            Some("cross_site_session"),
        ),
    ];
    for (headers, status, code) in cases {
        let mut request = browser.get(url(gw, "/settings")).header("cookie", cookie);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await?;
        assert_eq!(response.status().as_u16(), status, "{headers:?}");
        let body: serde_json::Value = response.json().await?;
        assert_eq!(body["error"]["code"].as_str(), code, "{headers:?}: {body}");
    }
    // A link from another local page lands on the connection screen.
    let navigation = browser
        .get(url(gw, "/"))
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-site")
        .header("accept", "text/html")
        .send()
        .await?;
    assert_eq!(navigation.status().as_u16(), 401);
    assert!(navigation.text().await?.contains("Connection code"));
    Ok(())
}

/// SEC-05: a state change with the cookie needs the page's own Origin and
/// the page itself; the cookie cannot mint further codes.
async fn assert_cookie_writes(
    gw: &Gateway,
    browser: &reqwest::Client,
    cookie: &str,
) -> Result<(), HarnessError> {
    let own_origin = gw.base.as_str();
    let body = json!({"language": "ko"}).to_string();
    for (site, origin, expected) in [
        ("same-origin", None, 403),
        ("same-origin", Some(own_origin), 200),
        ("same-site", Some(own_origin), 403),
    ] {
        let mut request = browser
            .patch(url(gw, "/settings"))
            .header("cookie", cookie)
            .header("sec-fetch-site", site)
            .header("content-type", "application/json")
            .body(body.clone());
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let status = request.send().await?.status().as_u16();
        assert_eq!(status, expected, "{site} origin {origin:?}");
    }
    let minted = browser
        .post(url(gw, "/connection-codes"))
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-origin")
        .header("origin", own_origin)
        .send()
        .await?;
    assert_eq!(minted.status().as_u16(), 403, "a session minted a code");
    Ok(())
}

/// SEC-07 — a message file opened in a browser never runs as a page of the
/// gateway origin, where its script would carry the session cookie: HTML
/// and SVG, fetched through a signed URL or with the session cookie, are
/// served as stored under a sandbox policy; a PDF keeps the browser's
/// viewer under its canonical type.
#[tokio::test]
async fn sec_07_message_files_never_run_as_gateway_pages() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-07")?.start().await?;
    let html = b"<!doctype html><script>fetch('/settings')</script>";
    let page =
        s.gw.upload("page.html", "text/html", html, Some("general"))
            .await?;
    assert_eq!(page.status, 201, "{}", page.text);
    let file = &page.data()["file"];
    let signed = file["signed_url"].as_str().expect("no signed_url");
    let by_signature = s.gw.http().get(url(&s.gw, signed)).send().await?;
    assert_sandboxed(by_signature, "text/html", html).await?;

    let browser = browser();
    let cookie = session_cookie(&s, &browser).await?;
    let plain = file["url"].as_str().unwrap();
    let by_cookie = browser
        .get(url(&s.gw, plain))
        .header("cookie", &cookie)
        .header("sec-fetch-site", "none")
        .header("accept", "text/html")
        .send()
        .await?;
    assert_sandboxed(by_cookie, "text/html", html).await?;

    // An SVG with a script, uploaded under a text file name.
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    let drawing =
        s.gw.upload("drawing.txt", "image/svg+xml", svg, Some("general"))
            .await?;
    assert_eq!(drawing.status, 201, "{}", drawing.text);
    let path = drawing.data()["file"]["url"].as_str().unwrap().to_owned();
    let served = s.gw.raw(reqwest::Method::GET, &path, &[]).await?;
    assert_sandboxed(served, "image/svg+xml", svg).await?;

    let pdf = b"%PDF-1.4\n%%EOF\n";
    let report =
        s.gw.upload("report.pdf", "application/pdf", pdf, Some("general"))
            .await?;
    assert_eq!(report.status, 201, "{}", report.text);
    let path = report.data()["file"]["url"].as_str().unwrap().to_owned();
    let served = s.gw.raw(reqwest::Method::GET, &path, &[]).await?;
    assert_eq!(served.status().as_u16(), 200);
    let headers = served.headers();
    assert_eq!(header(headers, "content-type"), "application/pdf");
    assert_eq!(header(headers, "x-content-type-options"), "nosniff");
    assert!(headers.get("content-security-policy").is_none());
    s.finish().await
}

async fn assert_sandboxed(
    response: reqwest::Response,
    content_type: &str,
    bytes: &[u8],
) -> Result<(), HarnessError> {
    assert_eq!(response.status().as_u16(), 200, "{content_type}");
    let headers = response.headers();
    assert_eq!(header(headers, "content-type"), content_type);
    assert_eq!(
        header(headers, "content-security-policy"),
        SANDBOXED_FILE_POLICY,
        "{content_type} not sandboxed"
    );
    assert_eq!(header(headers, "x-content-type-options"), "nosniff");
    assert_eq!(response.bytes().await?.to_vec(), bytes);
    Ok(())
}
