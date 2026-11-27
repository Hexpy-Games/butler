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
async fn sec_18_pairing_waits_for_owner_pick_decline_or_timeout() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-18")?.data_folder_token().start().await?;
    let app = admin(&s);

    let code = issue(&app).await?;
    let (response, pending) = tokio::join!(
        pair(&s.gw, code["code"].as_str().unwrap()),
        app.answer_pairing(Some("47")),
    );
    let pending = pending?;
    let request = pending["request"].as_object().unwrap();
    assert_eq!(request["device_name"], "Test phone");
    assert_eq!(request["platform"], "ios");
    assert!(!request.contains_key("match_code"));
    let choices = request["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 3);
    assert!(choices.iter().any(|choice| choice == "47"));
    assert!(choices.iter().all(|choice| {
        choice
            .as_str()
            .is_some_and(|number| number.len() == 2 && number.bytes().all(|b| b.is_ascii_digit()))
    }));
    assert!(choices[0] != choices[1] && choices[0] != choices[2] && choices[1] != choices[2]);
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
    let gw = s.gw.clone();
    let request_code = code.to_owned();
    let pending = tokio::spawn(async move { pair(&gw, &request_code).await });
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = app
                .send(Method::GET, "/security/pairing", None, &[])
                .await?;
            if status.data()["status"] == "pending" {
                return Ok::<_, HarnessError>(status);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("no pending pairing request")?;
    let pick = status.data()["request"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|choice| *choice != "47")
        .unwrap();
    let decision = app
        .send(
            Method::POST,
            "/security/pairing/decision",
            Some(json!({"id": status.data()["id"], "pick": pick})),
            &[],
        )
        .await?;
    assert_eq!(decision.status, 200);
    let response = pending.await.expect("pairing task panicked")?;
    assert_eq!(response.status, 403);
    assert_eq!(response.body["error"]["code"], "pairing_rejected");
    let status = app
        .send(Method::GET, "/security/pairing", None, &[])
        .await?;
    assert_eq!(status.data()["status"], "rejected");
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    assert_eq!(pair(&s.gw, code).await?.status, 401);

    let code = issue(&app).await?;
    let (response, pending) = tokio::join!(
        pair(&s.gw, code["code"].as_str().unwrap()),
        app.answer_pairing(None),
    );
    pending?;
    let response = response?;
    assert_eq!(response.status, 403);
    assert_eq!(response.body["error"]["code"], "pairing_rejected");
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);

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
            Some(json!({"id": issued["id"], "pick": "47"})),
            &[],
        )
        .await?;
    assert_eq!(decision.status, 409);
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    s.finish().await
}
