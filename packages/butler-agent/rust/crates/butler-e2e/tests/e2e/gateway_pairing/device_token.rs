use super::helpers::*;
use butler_e2e::e2e::{HarnessError, events::LiveEvents, gateway::Gateway, scenario::Setup};
use futures_util::StreamExt;
use reqwest::Method;
use std::time::Duration;

async fn pair(
    gw: &Gateway,
    client: &reqwest::Client,
    code: &str,
) -> Result<reqwest::Response, HarnessError> {
    Ok(client
        .post(format!("{}/devices/pair", gw.base))
        .json(&serde_json::json!({
            "code": code,
            "device_name": "Test phone",
            "platform": "ios",
            "match_code": "47",
            "public_key": "later",
        }))
        .send()
        .await?)
}

async fn status(
    gw: &Gateway,
    client: &reqwest::Client,
    token: &str,
    method: Method,
    path: &str,
) -> Result<u16, HarnessError> {
    Ok(client
        .request(method, format!("{}{path}", gw.base))
        .bearer_auth(token)
        .send()
        .await?
        .status()
        .as_u16())
}

#[tokio::test]
async fn sec_16_phone_pairs_with_device_token_until_revoked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SEC-16")?.data_folder_token().start().await?;
    let app = admin(&s);
    let events = LiveEvents::subscribe(&s.gw, 0).await?;
    let client = browser();
    let pin = issue(&app).await?;
    let code = pin["code"].as_str().unwrap();
    let (response, answer) = tokio::join!(pair(&s.gw, &client, code), app.answer_pairing(true),);
    answer?;
    let response = response?;
    assert_eq!(response.status().as_u16(), 201);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: serde_json::Value = response.json().await?;
    let token = body["data"]["device_token"].as_str().unwrap().to_owned();
    let id = body["data"]["device_id"].as_str().unwrap().to_owned();
    let butler_id = body["data"]["butler_id"].as_str().unwrap().to_owned();
    assert!(token.starts_with("bdt_"));
    assert_ne!(butler_id, "");
    assert_ne!(body["data"]["computer_name"].as_str().unwrap(), "");
    let notice = events
        .wait_for(Duration::from_secs(5), |event| {
            event["type"] == "security.device_paired"
        })
        .await?;
    assert_eq!(notice["payload"]["device_id"], id);
    assert_eq!(
        status(&s.gw, &client, &token, Method::GET, "/settings").await?,
        200
    );
    let admin_attempt = client
        .get(format!("{}/security", s.gw.base))
        .bearer_auth(&token)
        .header("x-butler-admin", s.agent.launch.admin_credential().unwrap())
        .send()
        .await?;
    assert_eq!(admin_attempt.status().as_u16(), 403);
    assert_eq!(
        admin_attempt.json::<serde_json::Value>().await?["error"]["code"],
        "loopback_required"
    );
    assert_eq!(
        status(&s.gw, &client, &token, Method::POST, "/connection-codes").await?,
        403
    );
    let again = pair(&s.gw, &client, code).await?;
    assert_eq!(again.status().as_u16(), 401);
    assert_eq!(
        again.json::<serde_json::Value>().await?["error"]["code"],
        "invalid_connection_code"
    );
    let listed = devices(&app).await?;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "Test phone");
    assert!(listed[0].get("secret_hash").is_none());
    drop(events);
    s.restart().await?;
    let app = admin(&s);
    assert_eq!(
        status(&s.gw, &client, &token, Method::GET, "/settings").await?,
        200
    );
    let other_pin = issue(&app).await?;
    let other_code = other_pin["code"].as_str().unwrap();
    let (other, answer) = tokio::join!(pair(&s.gw, &client, other_code), app.answer_pairing(true),);
    answer?;
    let other: serde_json::Value = other?.json().await?;
    let other_token = other["data"]["device_token"].as_str().unwrap().to_owned();
    assert_eq!(other["data"]["butler_id"], butler_id);
    let other_id = other["data"]["device_id"].as_str().unwrap().to_owned();
    let events = LiveEvents::subscribe(&s.gw, 0).await?;
    let not_device = app.send(Method::DELETE, "/devices/self", None, &[]).await?;
    assert_eq!(not_device.status, 403);
    assert_eq!(not_device.body["error"]["code"], "device_token_required");
    assert_eq!(
        status(
            &s.gw,
            &client,
            &other_token,
            Method::DELETE,
            "/devices/self"
        )
        .await?,
        204
    );
    assert_eq!(
        status(&s.gw, &client, &other_token, Method::GET, "/settings").await?,
        401
    );
    assert_eq!(
        status(&s.gw, &client, &token, Method::GET, "/settings").await?,
        200
    );
    let gone = events
        .wait_for(Duration::from_secs(5), |event| {
            event["type"] == "security.device_revoked"
        })
        .await?;
    assert_eq!(gone["payload"]["device_id"], other_id);
    drop(events);
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);
    let stream = client
        .get(format!("{}/events/live?cursor=0", s.gw.base))
        .bearer_auth(&token)
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
    assert_eq!(
        status(&s.gw, &client, &token, Method::GET, "/settings").await?,
        401
    );
    assert_no_secrets(&s, &[code, &token, other_code, &other_token])?;
    s.finish().await
}

#[tokio::test]
async fn phone_settings_parity_routes_preserve_security_boundary() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("phone-settings-parity")?
        .data_folder_token()
        .start()
        .await?;
    let client = browser();
    let app = admin(&s);
    let pin = issue(&app).await?;
    let (paired, answer) = tokio::join!(
        pair(&s.gw, &client, pin["code"].as_str().unwrap()),
        app.answer_pairing(true),
    );
    answer?;
    let paired: serde_json::Value = paired?.json().await?;
    let token = paired["data"]["device_token"].as_str().unwrap();
    let response = client
        .patch(format!("{}/settings", s.gw.base))
        .bearer_auth(token)
        .json(&serde_json::json!({ "show_thinking": false }))
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let response = client
        .get(format!("{}/settings", s.gw.base))
        .bearer_auth(token)
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let settings: serde_json::Value = response.json().await?;
    assert_eq!(settings["data"]["show_thinking"], false);
    let response = client
        .patch(format!("{}/settings", s.gw.base))
        .bearer_auth(token)
        .json(&serde_json::json!({ "security": { "remote_access_enabled": true } }))
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 403);
    for path in [
        "/personalization",
        "/memory/inventory",
        "/archives?limit=1",
        "/system-events?limit=1",
        "/usage-monitor?since_hours=24",
        "/skills",
        "/authority-permissions",
    ] {
        assert_eq!(
            status(&s.gw, &client, token, Method::GET, path).await?,
            200,
            "{path}"
        );
    }
    s.finish().await
}
