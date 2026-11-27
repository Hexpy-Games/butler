use super::helpers::*;
use std::time::Duration;

use butler_e2e::e2e::{
    HarnessError,
    gateway::{Gateway, Reply},
    scenario::Setup,
};
use reqwest::Method;
use serde_json::json;

async fn pair(gw: &Gateway, code: &str) -> Result<Reply, HarnessError> {
    gw.send_with(
        Method::POST,
        "/devices/pair",
        Some(
            json!({
                "code": code, "device_name": "Test phone", "platform": "ios", "match_code": "47",
            })
            .to_string(),
        ),
        None,
        &[],
    )
    .await
}

#[tokio::test]
async fn sec_18_pairing_waits_for_owner_allow_decline_or_timeout() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-18")?.data_folder_token().start().await?;
    let app = admin(&s);

    let code = issue(&app).await?;
    let (response, pending) = tokio::join!(
        pair(&s.gw, code["code"].as_str().unwrap()),
        app.answer_pairing(true),
    );
    assert_eq!(
        pending?["request"],
        json!({"device_name": "Test phone", "platform": "ios", "match_code": "47"}),
    );
    let response = response?;
    assert_eq!(response.status, 201);
    assert!(response.data()["device_token"].is_string());
    assert_ne!(response.data()["device_token"], "");
    let status = app
        .send(Method::GET, "/security/pairing", None, &[])
        .await?;
    assert_eq!(status.data()["status"], "paired");
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);

    let code = issue(&app).await?;
    let code = code["code"].as_str().unwrap();
    let (response, pending) = tokio::join!(pair(&s.gw, code), app.answer_pairing(false));
    pending?;
    let response = response?;
    assert_eq!(response.status, 403);
    assert_eq!(response.body["error"]["code"], "pairing_rejected");
    let status = app
        .send(Method::GET, "/security/pairing", None, &[])
        .await?;
    assert_eq!(status.data()["status"], "rejected");
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    assert_eq!(pair(&s.gw, code).await?.status, 401);

    let issued = issue(&app).await?;
    let gw = s.gw.clone();
    let code = issued["code"].as_str().unwrap().to_owned();
    let pending = tokio::spawn(async move { pair(&gw, &code).await });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = app
                .send(Method::GET, "/security/pairing", None, &[])
                .await?;
            if status.data()["status"] == "pending" {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("no pending pairing request")?;
    advance(&app, 60).await?;
    let response = pending.await.expect("pairing task panicked")?;
    assert_eq!(response.status, 410);
    assert_eq!(response.body["error"]["code"], "pairing_expired");
    let decision = app
        .send(
            Method::POST,
            "/security/pairing/decision",
            Some(json!({"id": issued["id"], "allow": true})),
            &[],
        )
        .await?;
    assert_eq!(decision.status, 409);
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    s.finish().await
}
