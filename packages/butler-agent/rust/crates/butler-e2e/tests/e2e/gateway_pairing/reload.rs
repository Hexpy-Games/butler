//! Browser pairing survives navigation and restart, and re-pairing replaces it.
use super::helpers::*;
use butler_e2e::e2e::{HarnessError, gateway::Gateway, scenario::Setup};

#[tokio::test]
async fn paired_browser_stays_paired_across_reload_restart_and_repair() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("REMOTE-RELOAD")?
        .data_folder_token()
        .start()
        .await?;
    let app = admin(&s);
    let browser = browser();
    let pin = issue(&app).await?;
    let response = connect(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
    assert_eq!(response.status().as_u16(), 303);
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("SameSite=Lax")
    );
    let cookie = cookie_pair(&response);
    let first_id = devices(&app).await?[0]["id"].clone();

    let reload = page(&s.gw, &browser, &cookie, "same-origin", "/").await;
    assert_ne!(reload.status().as_u16(), 401);
    assert!(!reload.text().await?.contains("Connection code"));
    let returned = page(&s.gw, &browser, &cookie, "cross-site", "/").await;
    assert_ne!(returned.status().as_u16(), 401);
    assert!(!returned.text().await?.contains("Connection code"));
    // An API path still needs the Butler page itself.
    let api = page(&s.gw, &browser, &cookie, "cross-site", "/settings").await;
    assert_eq!(api.status().as_u16(), 401);
    assert!(api.text().await?.contains("Connection code"));

    s.restart().await?;
    let app = admin(&s);
    let restarted = page(&s.gw, &browser, &cookie, "same-origin", "/").await;
    assert_ne!(restarted.status().as_u16(), 401);
    assert!(!restarted.text().await?.contains("Connection code"));

    let pin = issue(&app).await?;
    let repaired = browser
        .post(format!("{}/connect", s.gw.base))
        .header("origin", &s.gw.base)
        .header("sec-fetch-site", "same-origin")
        .header("cookie", &cookie)
        .form(&[("code", pin["code"].as_str().unwrap())])
        .send()
        .await?;
    assert_eq!(repaired.status().as_u16(), 303);
    let new_cookie = cookie_pair(&repaired);
    let paired = devices(&app).await?;
    assert_eq!(paired.as_array().unwrap().len(), 1);
    assert_ne!(paired[0]["id"], first_id);
    assert_eq!(read(&s.gw, &browser, &cookie).await?, 401);
    assert_eq!(read(&s.gw, &browser, &new_cookie).await?, 200);
    s.finish().await
}

async fn page(
    gw: &Gateway,
    browser: &reqwest::Client,
    cookie: &str,
    site: &str,
    path: &str,
) -> reqwest::Response {
    browser
        .get(format!("{}{path}", gw.base))
        .header("cookie", cookie)
        .header("accept", "text/html")
        .header("sec-fetch-site", site)
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .send()
        .await
        .unwrap()
}
