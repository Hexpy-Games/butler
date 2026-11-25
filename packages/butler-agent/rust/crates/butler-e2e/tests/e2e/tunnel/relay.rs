use axum::extract::ws::Message;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_e2e::e2e::{
    HarnessError, fake_butler_cloud::FakeButlerCloud, scenario::Setup, security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};

use super::phone::Phone;

#[tokio::test]
async fn tunnel_01_relay_reaches_routes_as_remote_peer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    fake.set_plan("plus");
    let setup = Setup::new("TUNNEL-01")?
        .env("BUTLER_CLOUD_API_URL", &fake.url)
        .stub_cassette(crate::browser_outputs::stub::cassette()?);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let signed_in = app
        .send(
            Method::POST,
            "/setup/butler-account",
            Some(json!({"action": "verify", "email": "user@example.com", "code": "123456"})),
            &[],
        )
        .await?;
    assert_eq!(signed_in.status, 200);
    let enabled = app
        .send(
            Method::PUT,
            "/security/tunnel",
            Some(json!({"enabled": true})),
            &[],
        )
        .await?;
    assert_eq!(enabled.status, 200);
    assert_eq!(enabled.data()["state"], "connected");
    let mut socket = fake.tunnel_socket().await;
    let view = app.view().await?;
    let desktop_public = URL_SAFE_NO_PAD
        .decode(view["tunnel"]["public_key"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let id = view["tunnel"]["tunnel_id"].as_str().unwrap();
    let pairing = app
        .send(Method::POST, "/security/pairing", None, &[])
        .await?;
    let phone = Phone::new();
    let paired =
        s.gw.post(
            "/devices/pair",
            json!({
                "code": pairing.data()["code"], "device_name": "Phone", "platform": "ios",
                "noise_static": phone.public_key(),
            }),
        )
        .await?;
    assert_eq!(paired.status, 201);
    let token = paired.data()["device_token"].as_str().unwrap();
    assert!(token.starts_with("bdt_"));
    let view_path = crate::content_port::publish(&s).await?;

    let health = phone
        .request(
            &mut socket,
            1,
            &desktop_public,
            id,
            "GET",
            "/health",
            Some(token),
            None,
        )
        .await
        .unwrap();
    assert_eq!(health.status, 200);
    let sessions = phone
        .request(
            &mut socket,
            2,
            &desktop_public,
            id,
            "GET",
            "/sessions",
            Some(token),
            None,
        )
        .await
        .unwrap();
    assert_eq!(sessions.status, 200);
    let envelope: Value = serde_json::from_slice(&sessions.body).unwrap();
    assert_eq!(envelope["protocol_version"], "butler.app.v1");
    assert!(envelope.get("data").is_some());
    let security = phone
        .request(
            &mut socket,
            3,
            &desktop_public,
            id,
            "GET",
            "/security",
            Some(token),
            None,
        )
        .await
        .unwrap();
    assert_eq!(security.status, 403);
    assert_eq!(
        serde_json::from_slice::<Value>(&security.body).unwrap()["error"]["code"],
        "loopback_required"
    );
    let output = phone
        .request(
            &mut socket,
            4,
            &desktop_public,
            id,
            "GET",
            &view_path,
            Some(token),
            None,
        )
        .await
        .unwrap();
    assert!(
        output.status == 200
            && serde_json::from_slice::<Value>(&output.body).unwrap()["data"]["url"]
                .as_str()
                .is_some_and(|url| url.starts_with("/__o/"))
    );

    let disabled = app
        .send(
            Method::PUT,
            "/security/tunnel",
            Some(json!({"enabled": false})),
            &[],
        )
        .await?;
    assert_eq!(disabled.status, 200);
    let Some(Ok(Message::Close(Some(close)))) = socket.recv().await else {
        panic!("expected WebSocket close");
    };
    assert_eq!(close.code, 1000);
    s.finish().await
}

#[tokio::test]
async fn tunnel_02_pairing_through_relay_requires_noise_key() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    fake.set_plan("plus");
    let setup = Setup::new("TUNNEL-02")?.env("BUTLER_CLOUD_API_URL", &fake.url);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let signed_in = app
        .send(
            Method::POST,
            "/setup/butler-account",
            Some(json!({"action": "verify", "email": "user@example.com", "code": "123456"})),
            &[],
        )
        .await?;
    assert_eq!(signed_in.status, 200);
    let enabled = app
        .send(
            Method::PUT,
            "/security/tunnel",
            Some(json!({"enabled": true})),
            &[],
        )
        .await?;
    assert_eq!(enabled.status, 200);
    assert_eq!(enabled.data()["state"], "connected");
    let mut socket = fake.tunnel_socket().await;
    let view = app.view().await?;
    let desktop_public = URL_SAFE_NO_PAD
        .decode(view["tunnel"]["public_key"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let id = view["tunnel"]["tunnel_id"].as_str().unwrap();
    let pairing = app
        .send(Method::POST, "/security/pairing", None, &[])
        .await?;
    let phone = Phone::new();

    let mut body =
        json!({"code": pairing.data()["code"], "device_name": "Phone", "platform": "android"});
    let mismatch = phone
        .request(
            &mut socket,
            1,
            &desktop_public,
            id,
            "POST",
            "/devices/pair",
            None,
            Some(body.clone()),
        )
        .await
        .unwrap();
    assert_eq!(mismatch.status, 403);
    assert_eq!(
        serde_json::from_slice::<Value>(&mismatch.body).unwrap()["error"]["code"],
        "noise_static_mismatch"
    );
    body["noise_static"] = json!(phone.public_key());
    let paired = phone
        .request(
            &mut socket,
            2,
            &desktop_public,
            id,
            "POST",
            "/devices/pair",
            None,
            Some(body),
        )
        .await
        .unwrap();
    assert_eq!(paired.status, 201);
    let envelope: Value = serde_json::from_slice(&paired.body).unwrap();
    let token = envelope["data"]["device_token"].as_str().unwrap();
    assert!(token.starts_with("bdt_"));
    let sessions = phone
        .request(
            &mut socket,
            3,
            &desktop_public,
            id,
            "GET",
            "/sessions",
            Some(token),
            None,
        )
        .await
        .unwrap();
    assert_eq!(sessions.status, 200);
    s.finish().await
}
