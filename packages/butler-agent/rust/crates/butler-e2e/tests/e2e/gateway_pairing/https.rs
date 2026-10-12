//! Transport security uses admitted forwarding metadata without granting access.
use super::helpers::*;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn proxied_https_cookies_and_remote_links() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("REMOTE-HTTPS")?
        .data_folder_token()
        .start()
        .await?;
    let app = admin(&s);
    let reply = app
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security": {
                "remote_access_enabled": true,
                "allowed_hosts": ["butler.example.com", format!("butler.example.com:{}", s.agent.launch.port), "workstation.local", "192.168.1.10"]
            }})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    let view = app.view().await?;
    let urls = view["lan_urls"].as_array().unwrap();
    assert!(urls.contains(&json!("https://butler.example.com")));
    assert!(urls.contains(&json!(format!(
        "http://workstation.local:{}",
        s.agent.launch.port
    ))));
    assert!(urls.contains(&json!(format!(
        "http://192.168.1.10:{}",
        s.agent.launch.port
    ))));
    for address in view["bind_addresses"].as_array().unwrap().iter().skip(1) {
        assert!(urls.contains(&json!(format!("http://{}", address.as_str().unwrap()))));
    }
    app.set_remote(false).await?;
    assert_eq!(
        app.view().await?["lan_urls"],
        json!(["https://butler.example.com"])
    );
    let browser = browser();
    for (name, value, secure) in [
        ("x-forwarded-proto", "https", true),
        ("forwarded", "for=192.0.2.1;proto=https", true),
        ("forwarded", "for=192.0.2.1; Proto=\"HTTPS\"", true),
        ("cf-visitor", r#"{"scheme":"https"}"#, true),
        ("x-forwarded-proto", "http", false),
        ("x-forwarded-proto", "http, https", false),
        ("forwarded", "for=192.0.2.1;proto=http", false),
        ("cf-visitor", r#"{"scheme":"http"}"#, false),
        ("cf-visitor", "malformed", false),
    ] {
        let pin = issue(&app).await?;
        let response = browser
            .post(format!("{}/connect", s.gw.base))
            .header("host", "butler.example.com")
            .header("origin", "https://butler.example.com")
            .header("sec-fetch-site", "same-origin")
            .header(name, value)
            .form(&[("code", pin["code"].as_str().unwrap())])
            .send()
            .await?;
        assert_eq!(response.status().as_u16(), 303);
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert_eq!(
            cookie.split(';').any(|part| part.trim() == "Secure"),
            secure
        );
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    }
    let pin = issue(&app).await?;
    let local = connect(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
    assert_eq!(local.status().as_u16(), 303);
    assert!(
        !local.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Secure")
    );
    let pin = issue(&app).await?;
    let rewritten = browser
        .post(format!("{}/connect", s.gw.base))
        .header("origin", "https://butler.example.com")
        .header("sec-fetch-site", "same-origin")
        .header("x-forwarded-proto", "https")
        .form(&[("code", pin["code"].as_str().unwrap())])
        .send()
        .await?;
    assert_eq!(rewritten.status().as_u16(), 303);
    assert!(
        rewritten.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("; Secure")
    );
    let denied = browser
        .post(format!("{}/connect", s.gw.base))
        .header("host", "unregistered.example.com")
        .header("x-forwarded-proto", "https")
        .form(&[("code", "00000000")])
        .send()
        .await?;
    assert_eq!(denied.status().as_u16(), 403);
    assert!(denied.headers().get("set-cookie").is_none());
    let remote_admin = app
        .send(
            Method::GET,
            "/security",
            None,
            &[("cf-visitor", r#"{"scheme":"https"}"#)],
        )
        .await?;
    assert_eq!(remote_admin.status, 403);
    s.finish().await
}
