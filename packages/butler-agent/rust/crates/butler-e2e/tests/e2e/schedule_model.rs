//! Per-schedule models through the real gateway, CLI and stub provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer},
    fixtures,
    gateway::{TERMINAL, turn_state},
    scenario::{Fixture, Scenario, Setup, turn_timeout},
};
use serde_json::{Value, json};
use std::time::Duration;

const X: &str = "qwen/qwen3.8-max";
const Y: &str = "qwen/qwen3.7-max";
const Z: &str = "qwen/qwen3.7-plus";

async fn setup(id: &str) -> Result<(Scenario, FakeServer, String), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new(id)?.fixture(Fixture::Empty);
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    let api = format!("{}/v1", server.base_url);
    let registered: Vec<Value> = [X, Y, Z]
        .iter()
        .map(|model| {
            json!({"provider_id":"qwen", "model_id":model.strip_prefix("qwen/").unwrap(),
            "auth_type":"api_key", "credential_id":"qwen-e2e", "api_base_url":api})
        })
        .collect();
    std::fs::write(
        setup.sandbox.data.join("butler.config.json"),
        json!({"models":{"registered":registered}}).to_string(),
    )?;
    std::fs::create_dir_all(setup.sandbox.data.join("auth"))?;
    std::fs::write(setup.sandbox.data.join("auth/model-provider-credentials.json"),
        json!({"credentials":[{"id":"qwen-e2e", "provider_id":"qwen", "auth_type":"api_key", "secret":"e2e-placeholder"}]}).to_string())?;
    let s = setup.start().await?;
    s.patch_settings(
        json!({"model":Z, "access_mode":"full_access"}),
        "default model",
    )
    .await?;
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat", "title":"Schedule target"}),
        )
        .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    Ok((s, server, chat))
}

fn body(model: Option<&str>, chat: &str) -> Value {
    let mut value = json!({"title":"Model schedule", "prompt_body":"Reply with one word.",
        "target_session_id":chat, "interval_seconds":3600});
    if let Some(model) = model {
        value["model"] = model.into();
    }
    value
}

async fn create(s: &Scenario, model: Option<&str>, chat: &str) -> Result<String, HarnessError> {
    let reply = s.gw.post("/automations", body(model, chat)).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

fn turn_models(server: &FakeServer) -> Vec<String> {
    server
        .chat_requests()
        .iter()
        .filter(|r| r["tools"].is_array())
        .filter_map(|r| r["model"].as_str().map(str::to_owned))
        .collect()
}

async fn run(
    s: &Scenario,
    server: &FakeServer,
    id: &str,
    chat: &str,
    model: &str,
) -> Result<(), HarnessError> {
    let before = turn_models(server).len();
    let reply =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_eq!(reply.data()["run"]["state"], "succeeded", "{}", reply.text);
    let turn_id = reply.data()["run"]["turn_id"].as_str().unwrap().to_owned();
    let turn =
        s.gw.wait_turn(
            chat,
            &turn_id,
            TERMINAL,
            Duration::from_secs(turn_timeout()),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let models = turn_models(server);
    assert_eq!(models.len(), before + 1, "{models:?}");
    assert_eq!(models.last().unwrap(), model.strip_prefix("qwen/").unwrap());
    Ok(())
}

#[tokio::test]
async fn sched_model_01_create_selects_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, server, chat) = setup("SCHED-MODEL-01").await?;
    let id = create(&s, Some(X), &chat).await?;
    run(&s, &server, &id, &chat, X).await?;
    let read = s.gw.get(&format!("/automations/{id}")).await?;
    assert_eq!(read.data()["automation"]["model"], X);
    let controls = s.gw.get(&format!("/sessions/{chat}/controls")).await?;
    assert_eq!(controls.data()["controls"]["model"], Z);
    s.finish().await
}

#[tokio::test]
async fn sched_model_02_update_selects_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, server, chat) = setup("SCHED-MODEL-02").await?;
    let id = create(&s, Some(X), &chat).await?;
    run(&s, &server, &id, &chat, X).await?;
    let reply =
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"model":"qwen3.7-max"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["automation"]["model"], Y);
    let reply =
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"title":"Updated title"}),
        )
        .await?;
    assert_eq!(reply.data()["automation"]["model"], Y);
    run(&s, &server, &id, &chat, Y).await?;
    s.finish().await
}

#[tokio::test]
async fn sched_model_03_deleted_and_omitted_models_inherit_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, server, chat) = setup("SCHED-MODEL-03").await?;
    let reply =
        s.gw.patch(&format!("/sessions/{chat}/controls"), json!({"model":Z}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    s.patch_settings(json!({"model":Y}), "different default")
        .await?;
    let id = create(&s, Some(X), &chat).await?;
    let deleted =
        s.gw.delete("/model-catalog/registered-models/qwen%2Fqwen3.8-max")
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    run(&s, &server, &id, &chat, Z).await?;
    let id = create(&s, None, &chat).await?;
    run(&s, &server, &id, &chat, Z).await?;
    s.finish().await
}

#[tokio::test]
async fn sched_model_05_cleared_model_inherits_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, server, chat) = setup("SCHED-MODEL-05").await?;
    let reply =
        s.gw.patch(&format!("/sessions/{chat}/controls"), json!({"model":Z}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    s.patch_settings(json!({"model":Y}), "different default")
        .await?;
    let id = create(&s, Some(X), &chat).await?;
    run(&s, &server, &id, &chat, X).await?;
    let reply =
        s.gw.patch(&format!("/automations/{id}"), json!({"model":""}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(reply.data()["automation"]["model"].is_null());
    let read = s.gw.get(&format!("/automations/{id}")).await?;
    assert!(read.data()["automation"]["model"].is_null());
    run(&s, &server, &id, &chat, Z).await?;
    s.finish().await
}

#[tokio::test]
async fn sched_model_04_unknown_models_are_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _server, chat) = setup("SCHED-MODEL-04").await?;
    let refused =
        s.gw.post("/automations", body(Some("qwen/missing"), &chat))
            .await?;
    assert_eq!(refused.status, 409, "{}", refused.text);
    assert_eq!(refused.body["error"]["code"], "session_model_unavailable");
    let id = create(&s, Some(X), &chat).await?;
    let refused =
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"model":"qwen/missing"}),
        )
        .await?;
    assert_eq!(refused.status, 409, "{}", refused.text);
    assert_eq!(refused.body["error"]["code"], "session_model_unavailable");
    s.finish().await
}

#[tokio::test]
async fn sched_model_cli_create_and_update() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _server, chat) = setup("SCHED-MODEL-CLI").await?;
    let created = s.agent.cli(&[
        "schedule",
        "create",
        "--session",
        &chat,
        "--prompt",
        "Reply with one word.",
        "--interval-seconds",
        "3600",
        "--model",
        X,
        "--json",
    ])?;
    assert_eq!(created.code, Some(0), "{}", created.stderr);
    let value = created.json()?;
    assert_eq!(value["data"]["automation"]["model"], X);
    let id = value["data"]["automation"]["id"].as_str().unwrap();
    let read = s.gw.get(&format!("/automations/{id}")).await?;
    assert_eq!(read.data()["automation"]["model"], X);
    let updated = s
        .agent
        .cli(&["schedule", "update", id, "--model", Y, "--json"])?;
    assert_eq!(updated.code, Some(0), "{}", updated.stderr);
    assert_eq!(updated.json()?["data"]["automation"]["model"], Y);
    let read = s.gw.get(&format!("/automations/{id}")).await?;
    assert_eq!(read.data()["automation"]["model"], Y);
    s.finish().await
}
