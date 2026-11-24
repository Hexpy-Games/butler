//! The main records computer sign-in and refuses to deploy into the remote home.
use super::computer_account::{Deployed, deployed};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};
use std::{fs, path::Path};

#[tokio::test]
async fn computer_records_ai_connection_and_refuses_home_folder() -> Result<(), HarnessError> {
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
    } = deployed("COMPUTER-AI-CONNECTION", &[]).await?;
    let added = api
        .send(
            Method::POST,
            "/computers",
            Some(json!({
                "name": "Home",
                "address": "127.0.0.1",
                "port": sshd.port,
                "key_file": s.sandbox.home.join("key"),
                "folder": remote.0.home,
            })),
            &[],
        )
        .await?;
    assert_eq!(added.status, 201, "{added:?}");
    let home_id = added.data()["computer"]["id"].as_str().unwrap();
    let refused = api
        .send(
            Method::POST,
            &format!("/computers/{home_id}/start"),
            None,
            &[],
        )
        .await?;
    assert_eq!(refused.status, 422, "{refused:?}");
    assert_eq!(refused.error_code(), Some("project_folder_unsafe"));
    assert!(
        remote
            .0
            .home
            .join(".butler-remote/current")
            .symlink_metadata()
            .is_err()
    );
    assert!(fs::read_dir(&remote.1)?.next().is_none());

    let ai_connected = |list: &Value| {
        list["computers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|computer| computer["id"] == id)
            .unwrap()["ai_connected"]
            .as_bool()
    };
    let list = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(list.status, 200);
    assert_eq!(ai_connected(list.data()), Some(false));
    let key = uuid::Uuid::new_v4().to_string();
    let saved = api
        .send(
            Method::POST,
            "/credentials",
            Some(json!({
                "provider_id": "openai", "api_key": key,
            })),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 201);
    let cid = saved.data()["credential"]["id"].as_str().unwrap();
    let sent = api
        .send(
            Method::PATCH,
            &format!("/computers/{id}"),
            Some(json!({"model_source":{"key":cid}})),
            &[],
        )
        .await?;
    assert_eq!(sent.status, 200);
    let list = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(list.status, 200);
    assert_eq!(ai_connected(list.data()), Some(true));
    drop((remote, sshd, files));
    s.finish().await
}
