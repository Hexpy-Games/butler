//! A computer following the main's model receives and rotates its saved key.
use super::computer_account::{Deployed, deployed, socket};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};
use std::{fs, path::Path};

#[tokio::test]
async fn computer_follows_the_main_default_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let Deployed {
        s,
        remote,
        sshd,
        files,
        api,
        id,
        ..
    } = deployed("COMPUTER-MODEL-SYNC", &[]).await?;
    let model = "anthropic/claude-haiku-4-5";
    let computer_path = format!("/computers/{id}");
    let start_path = format!("{computer_path}/start");
    let config_path = remote.0.data.join("butler.config.json");

    let saved = api
        .send(
            Method::POST,
            "/credentials",
            Some(json!({"provider_id":"anthropic","api_key":"sk-ant-e2e-first"})),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 201, "{saved:?}");
    let registered = api
        .send(
            Method::POST,
            "/model-catalog/registered-models",
            Some(json!({
                "provider_id":"anthropic","model_id":"claude-haiku-4-5",
                "auth_type":"api_key","credential_id":saved.data()["credential"]["id"],
            })),
            &[],
        )
        .await?;
    assert_eq!(registered.status, 201, "{registered:?}");
    let settings = api
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"model":model})),
            &[],
        )
        .await?;
    assert_eq!(settings.status, 200, "{settings:?}");
    let list = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(list.status, 200);
    assert_eq!(list.data()["main_model"], "key");
    assert_eq!(list.data()["computers"][0]["ai_connected"], false);

    let updated = api
        .send(
            Method::PATCH,
            &computer_path,
            Some(json!({"model_source":"follow"})),
            &[],
        )
        .await?;
    assert_eq!(updated.status, 200, "{updated:?}");
    assert_eq!(updated.data()["computer"]["ai_connected"], true);

    let (status, body) = socket(&remote.0, "GET", "/credentials", None).await?;
    assert_eq!(status, 200);
    let credentials = body["data"]["credentials"].as_array().unwrap();
    assert_eq!(credentials.len(), 1);
    assert_eq!(credentials[0]["provider_id"], "anthropic");
    let r1 = credentials[0]["id"].as_str().unwrap();
    let config: Value = serde_json::from_slice(&fs::read(&config_path)?)?;
    assert_eq!(config["system"]["defaultModel"], model);
    let entry = config["models"]["registered"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["model_ref"] == model)
        .unwrap();
    assert_eq!(entry["credential_id"], r1);

    let saved = api
        .send(
            Method::POST,
            "/credentials",
            Some(json!({"provider_id":"anthropic","api_key":"sk-ant-e2e-second"})),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 201, "{saved:?}");
    let registered = api
        .send(
            Method::POST,
            "/model-catalog/registered-models",
            Some(json!({
                "provider_id":"anthropic","model_id":"claude-haiku-4-5",
                "auth_type":"api_key","credential_id":saved.data()["credential"]["id"],
            })),
            &[],
        )
        .await?;
    assert_eq!(registered.status, 201, "{registered:?}");
    let started = api.send(Method::POST, &start_path, None, &[]).await?;
    assert_eq!(started.status, 200, "{started:?}");

    let (status, body) = socket(&remote.0, "GET", "/credentials", None).await?;
    assert_eq!(status, 200);
    let credentials = body["data"]["credentials"].as_array().unwrap();
    assert_eq!(credentials.len(), 1);
    let r2 = credentials[0]["id"].as_str().unwrap();
    assert_ne!(r1, r2);
    let config: Value = serde_json::from_slice(&fs::read(&config_path)?)?;
    assert_eq!(config["system"]["defaultModel"], model);
    let entry = config["models"]["registered"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["model_ref"] == model)
        .unwrap();
    assert_eq!(entry["credential_id"], r2);

    let registered = api
        .send(
            Method::POST,
            "/model-catalog/registered-models",
            Some(json!({"provider_id":"openai","model_id":"gpt-5.5","auth_type":"chatgpt_oauth"})),
            &[],
        )
        .await?;
    assert_eq!(registered.status, 201, "{registered:?}");
    let settings = json!({"model":"openai/gpt-5.5"});
    let changed = api
        .send(Method::PATCH, "/settings", Some(settings.clone()), &[])
        .await?;
    assert_eq!(changed.status, 200, "{changed:?}");
    let list = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(list.status, 200);
    assert_eq!(list.data()["main_model"], "chatgpt");

    let (status, _) = socket(&remote.0, "PATCH", "/settings", Some(&settings)).await?;
    assert_eq!(status, 200);
    let (status, _) = socket(
        &remote.0,
        "DELETE",
        &format!("/credentials/{r2}?force=true"),
        None,
    )
    .await?;
    assert_eq!(status, 200);
    let started = api.send(Method::POST, &start_path, None, &[]).await?;
    assert_eq!(started.status, 200, "{started:?}");
    let list = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(list.status, 200);
    assert_eq!(list.data()["computers"][0]["ai_connected"], false);
    drop((remote, sshd, files));
    s.finish().await
}
