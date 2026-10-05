use super::{header, open_link};
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::security::AdminClient;
use reqwest::Method;
use serde_json::json;

/// A browser's form Origin under the page's Referrer-Policy. Fetch treats a
/// POST from a `no-referrer` page as opaque (`null`); `same-origin` sends the
/// document's serialized origin.
fn form_origin(page_url: &str, referrer_policy: &str) -> String {
    match referrer_policy {
        "same-origin" => {
            let (scheme, rest) = page_url.split_once("://").expect("absolute page URL");
            let authority = rest.split('/').next().expect("page authority");
            format!("{scheme}://{authority}")
        }
        "no-referrer" => "null".to_owned(),
        other => panic!("unexpected Referrer-Policy {other:?}"),
    }
}

/// A port-forwarder Host registered in `allowed_hosts` must serve the same
/// browser form flow as a loopback Host, including the Origin policy.
#[tokio::test]
async fn connect_form_uses_page_origin_and_renders_browser_errors() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const FORWARDER: &str = "preview-forwarder.test";
    let s = Setup::new("GW-CONNECT-ORIGIN")?
        .data_folder_token()
        .start()
        .await?;
    let admin = AdminClient::new(
        s.gw.clone(),
        s.agent.launch.admin_credential().expect("admin credential"),
    );
    let configured = admin
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security": {"allowed_hosts": [FORWARDER]}})),
            &[],
        )
        .await?;
    assert_eq!(configured.status, 200, "{}", configured.text);

    let port = s.agent.launch.port;
    let base = format!("http://{FORWARDER}:{port}");
    let page_url = format!("{base}/connect");
    let browser = reqwest::Client::builder()
        .resolve(FORWARDER, format!("127.0.0.1:{port}").parse().unwrap())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let page = browser
        .get(&page_url)
        .header("accept", "text/html")
        .send()
        .await?;
    assert_eq!(page.status().as_u16(), 200);
    let referrer_policy = header(page.headers(), "referrer-policy");
    assert_eq!(referrer_policy, "same-origin");
    assert!(header(page.headers(), "content-security-policy").contains("form-action 'self'"));
    let origin = form_origin(&page_url, referrer_policy);
    assert_eq!(origin, base);

    let wrong = browser
        .post(format!("{base}/connect"))
        .header("accept", "text/html,application/xhtml+xml")
        .header("origin", &origin)
        .header("sec-fetch-site", "same-origin")
        .header("content-type", "application/x-www-form-urlencoded")
        .body("code=wrong-code")
        .send()
        .await?;
    assert_eq!(wrong.status().as_u16(), 401);
    assert!(header(wrong.headers(), "content-type").starts_with("text/html"));
    assert!(header(wrong.headers(), "content-security-policy").contains("form-action 'self'"));
    assert!(wrong.text().await?.contains("That code is not valid."));

    let foreign_site = browser
        .post(format!("{base}/connect"))
        .header("accept", "text/html")
        .header("origin", &origin)
        .header("sec-fetch-site", "same-site")
        .header("content-type", "application/x-www-form-urlencoded")
        .body("code=wrong-code")
        .send()
        .await?;
    assert_eq!(foreign_site.status().as_u16(), 403);
    assert!(header(foreign_site.headers(), "content-type").starts_with("text/html"));
    assert!(
        foreign_site
            .text()
            .await?
            .contains("This connection request is not allowed.")
    );

    assert_html_rejection(
        browser
            .post(format!("{base}/connect"))
            .header("accept", "text/html")
            .header("origin", "null")
            .header("sec-fetch-site", "same-origin")
            .header("content-type", "application/x-www-form-urlencoded")
            .body("code=wrong-code")
            .send()
            .await?,
        403,
    )
    .await?;

    assert_html_rejection(
        browser
            .post(format!("{base}/connect"))
            .header("host", format!("not-allowed.test:{port}"))
            .header("accept", "text/html")
            .header("origin", &origin)
            .header("sec-fetch-site", "same-origin")
            .header("content-type", "application/x-www-form-urlencoded")
            .body("code=wrong-code")
            .send()
            .await?,
        403,
    )
    .await?;

    let xhr = browser
        .post(format!("{base}/connect"))
        .header("accept", "*/*")
        .header("origin", &origin)
        .header("sec-fetch-site", "same-origin")
        .header("content-type", "application/x-www-form-urlencoded")
        .body("code=wrong-code")
        .send()
        .await?;
    assert_eq!(xhr.status().as_u16(), 401);
    assert!(header(xhr.headers(), "content-type").starts_with("application/json"));
    let xhr_error: serde_json::Value = xhr.json().await?;
    assert_eq!(xhr_error["error"]["code"], "invalid_connection_code");

    let xhr_denied_origin = browser
        .post(format!("{base}/connect"))
        .header("accept", "*/*")
        .header("origin", "null")
        .header("sec-fetch-site", "same-origin")
        .header("content-type", "application/x-www-form-urlencoded")
        .body("code=wrong-code")
        .send()
        .await?;
    assert_eq!(xhr_denied_origin.status().as_u16(), 403);
    assert!(header(xhr_denied_origin.headers(), "content-type").starts_with("application/json"));
    let xhr_origin_error: serde_json::Value = xhr_denied_origin.json().await?;
    assert_eq!(xhr_origin_error["error"]["code"], "origin_not_allowed");

    let (link, code) = open_link(&s)?;
    assert!(link.contains("/connect?code="));
    let redeemed = browser
        .post(format!("{base}/connect"))
        .header("accept", "text/html,application/xhtml+xml")
        .header("origin", &origin)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(format!("code={code}"))
        .send()
        .await?;
    assert_eq!(redeemed.status().as_u16(), 303);
    let location = header(redeemed.headers(), "location");
    assert_eq!(location, "/");
    let cookie = header(redeemed.headers(), "set-cookie")
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let app = browser
        .get(format!("{base}{location}"))
        .header("accept", "text/html")
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await?;
    assert_eq!(app.status().as_u16(), 200);
    assert!(app.text().await?.contains("<title>e2e</title>"));
    s.finish().await
}

async fn assert_html_rejection(
    response: reqwest::Response,
    status: u16,
) -> Result<(), HarnessError> {
    assert_eq!(response.status().as_u16(), status);
    assert!(header(response.headers(), "content-type").starts_with("text/html"));
    assert!(
        response
            .text()
            .await?
            .contains("This connection request is not allowed.")
    );
    Ok(())
}
