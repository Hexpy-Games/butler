//! SEC-13/14/15: durable devices, short codes and foreground headless pairing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod gateway_pairing {
    pub(crate) mod cli;
    pub(crate) mod helpers;
    pub(crate) mod idle;
}
use butler_e2e::e2e::{HarnessError, events::LiveEvents, scenario::Setup};
use futures_util::StreamExt;
use gateway_pairing::helpers::*;
use reqwest::Method;
use std::time::Duration;

#[tokio::test]
async fn sec_13_pair_cookie_list_restart_and_revoke_stream() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-13")?.data_folder_token().start().await?;
    let app = admin(&s);
    let events = LiveEvents::subscribe(&s.gw, 0).await?;
    let browser = browser();
    let pin = issue(&app).await?;
    let response = connect(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
    assert_eq!(response.status().as_u16(), 303);
    let cookie = cookie_pair(&response);
    assert!(cookie.contains("=v2."));
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly")
    );
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("SameSite=Strict")
    );
    let notice = events
        .wait_for(Duration::from_secs(5), |event| {
            event["type"] == "security.device_paired"
        })
        .await?;
    let listed = devices(&app).await?;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let id = listed[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(notice["payload"]["device_id"], id);
    let device = app
        .send(Method::GET, &format!("/security/devices/{id}"), None, &[])
        .await?;
    assert_eq!(device.status, 200);
    assert_eq!(device.data(), &listed[0]);
    assert_eq!(listed[0]["name"], "Remote device · browser");
    assert_eq!(listed[0]["ip"], "127.0.0.1");
    assert!(listed[0].get("secret_hash").is_none());
    assert!(!notice.to_string().contains(pin["code"].as_str().unwrap()));
    assert!(
        !notice
            .to_string()
            .contains(cookie.split('.').next_back().unwrap())
    );
    drop(events);
    s.restart().await?;
    let app = admin(&s);
    assert_eq!(devices(&app).await?, listed);
    assert_eq!(read(&s.gw, &browser, &cookie).await?, 200);
    let other_pin = issue(&app).await?;
    let other_response = connect(&s.gw, &browser, other_pin["code"].as_str().unwrap()).await?;
    let other_cookie = cookie_pair(&other_response);
    let stream = browser
        .get(format!("{}/events/live?cursor=0", s.gw.base))
        .header("cookie", &cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await?;
    assert_eq!(stream.status().as_u16(), 200);
    let drain = tokio::spawn(async move {
        let mut chunks = stream.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            chunk?;
        }
        Ok::<(), reqwest::Error>(())
    });
    let revoked = app
        .send(
            Method::DELETE,
            &format!("/security/devices/{id}"),
            None,
            &[],
        )
        .await?;
    assert_eq!(revoked.status, 200);
    tokio::time::timeout(Duration::from_secs(5), drain)
        .await
        .expect("revocation did not close SSE")
        .expect("SSE drain panicked")?;
    assert_eq!(read(&s.gw, &browser, &cookie).await?, 401);
    assert_eq!(read(&s.gw, &browser, &other_cookie).await?, 200);
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    assert_eq!(
        app.send(Method::DELETE, "/security/devices", None, &[])
            .await?
            .status,
        200
    );
    assert!(devices(&app).await?.as_array().unwrap().is_empty());
    assert_eq!(read(&s.gw, &browser, &other_cookie).await?, 401);
    s.restart().await?;
    assert_eq!(read(&s.gw, &browser, &cookie).await?, 401);
    assert!(devices(&admin(&s)).await?.as_array().unwrap().is_empty());
    assert_no_secrets(
        &s,
        &[
            pin["code"].as_str().unwrap(),
            &cookie,
            other_pin["code"].as_str().unwrap(),
            &other_cookie,
        ],
    )?;
    s.finish().await
}

#[tokio::test]
async fn sec_14_pairing_codes_are_bounded_single_use_and_post_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-14")?.data_folder_token().start().await?;
    let app = admin(&s);
    let browser = browser();
    let no_pin = rejected(&s.gw, &browser, "00000000").await?;
    let pin = issue(&app).await?;
    assert_eq!(pin["code"].as_str().unwrap().len(), 8);
    assert!(
        pin["code"]
            .as_str()
            .unwrap()
            .bytes()
            .all(|b| b.is_ascii_digit())
    );
    assert_eq!(pin["expires_in"], 60);
    let get = browser
        .get(format!("{}/connect", s.gw.base))
        .query(&[("code", &pin["code"])])
        .send()
        .await?;
    assert_eq!(get.status().as_u16(), 401);
    assert!(get.headers().get("set-cookie").is_none());
    for _ in 0..3 {
        assert_eq!(rejected(&s.gw, &browser, "wrong").await?, no_pin);
    }
    let status = app
        .send(Method::GET, "/security/pairing", None, &[])
        .await?;
    assert_eq!(status.data()["status"], "invalidated");
    assert_eq!(status.data()["invalidated_by"], "127.0.0.1");
    assert_eq!(
        rejected(&s.gw, &browser, pin["code"].as_str().unwrap()).await?,
        no_pin
    );
    let old = issue(&app).await?;
    let current = issue(&app).await?;
    assert_eq!(
        rejected(&s.gw, &browser, old["code"].as_str().unwrap()).await?,
        no_pin
    );
    let paired = connect(&s.gw, &browser, current["code"].as_str().unwrap()).await?;
    assert_eq!(paired.status().as_u16(), 303);
    assert_eq!(
        rejected(&s.gw, &browser, current["code"].as_str().unwrap()).await?,
        no_pin
    );
    let expires = issue(&app).await?;
    advance(&app, 59).await?;
    assert_eq!(
        app.send(Method::GET, "/security/pairing", None, &[])
            .await?
            .data()["status"],
        "active"
    );
    advance(&app, 1).await?;
    assert_eq!(
        rejected(&s.gw, &browser, expires["code"].as_str().unwrap()).await?,
        no_pin
    );
    assert_eq!(
        app.send(Method::GET, "/security/pairing", None, &[])
            .await?
            .data()["status"],
        "expired"
    );
    assert_eq!(rejected(&s.gw, &browser, &s.gw.token).await?, no_pin);
    let v1 = format!(
        "butler_session_{}=v1.9999999999.nonce.signature",
        s.agent.launch.port
    );
    assert_eq!(read(&s.gw, &browser, &v1).await?, 401);
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    assert_no_secrets(
        &s,
        &[
            pin["code"].as_str().unwrap(),
            current["code"].as_str().unwrap(),
        ],
    )?;
    s.finish().await
}
