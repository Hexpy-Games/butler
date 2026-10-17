//! Model-less first turn through the real agent and a strict stub provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Fixture, Setup},
};
use serde_json::{Value, json};

#[tokio::test]
async fn fresh_connected_provider_without_model_uses_routine_on_wire() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("Q-02")?;
    let model = "openai/gpt-6.1-sol";
    cassette.meta.model = model.into();
    cassette.meta.effort = Some("medium".into());
    for exchange in &mut cassette.exchanges {
        exchange.request.key.effort = Some("medium".into());
        exchange.request.key.model = model.strip_prefix("openai/").unwrap().into();
    }
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let setup = Setup::new("DEFAULT-MODEL")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette);
    butler_e2e::e2e::fixtures::scheduler_ran_today(
        &setup.sandbox.data,
        butler_e2e::e2e::fixtures::FIXTURE_TIME,
    )?;
    butler_e2e::e2e::fixtures::onboarding_complete(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    let path = s.sandbox.data.join("butler.config.json");
    let config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    for field in ["butlerModel", "defaultModel", "workerModel", "openaiModel"] {
        assert!(
            config["system"].get(field).is_none(),
            "{field} unexpectedly persisted"
        );
    }
    assert_eq!(s.gw.settings().await?["model"], model);
    assert!(
        s.agent
            .logs()
            .contains("[native-butler] ready model=openai/gpt-6.1-sol provider=openai")
    );
    s.gw.patch("/settings", json!({"access_mode":"full_access"}))
        .await?;
    let (_, turn) = s.turn("general", &prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert_ne!(requests, [] as [serde_json::Value; 0]);
    assert!(
        requests.iter().all(|r| r["model"] == "gpt-6.1-sol"),
        "{requests:?}"
    );
    let status = s.agent.cli(&["model", "status", "--json"])?.json()?;
    assert_eq!(status["data"]["modelRef"], model, "{status}");
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["model"], model);
    assert!(
        s.agent
            .logs()
            .contains("[native-butler] ready model=openai/gpt-6.1-sol provider=openai")
    );
    s.finish().await
}

#[tokio::test]
async fn connected_provider_routine_shares_connection_without_saving_a_model()
-> Result<(), HarnessError> {
    use butler_e2e::e2e::{
        fake_servers::{ChatBehavior, FakeServer},
        fixtures,
    };
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("DEFAULT-QWEN")?.fixture(Fixture::Empty);
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    let config = json!({"models":{"registered":[{
        "provider_id":"qwen", "model_id":"qwen3.8-max", "auth_type":"api_key",
        "credential_id":"qwen-e2e", "api_base_url":format!("{}/v1", server.base_url)
    }]}});
    let path = setup.sandbox.data.join("butler.config.json");
    std::fs::write(&path, config.to_string())?;
    std::fs::create_dir_all(setup.sandbox.data.join("auth"))?;
    std::fs::write(setup.sandbox.data.join("auth/model-provider-credentials.json"),
        json!({"credentials":[{"id":"qwen-e2e", "provider_id":"qwen", "auth_type":"api_key", "secret":"e2e-placeholder"}]}).to_string())?;
    let s = setup.start().await?;
    let model = "qwen/qwen3.7-plus";
    assert_eq!(s.gw.settings().await?["model"], model);
    assert!(
        s.agent
            .logs()
            .contains("ready model=qwen/qwen3.7-plus provider=qwen")
    );
    s.gw.patch("/settings", json!({"access_mode":"full_access"}))
        .await?;
    let (_, turn) = s.turn("general", "Reply with one word.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    // Completion starts semantic extraction asynchronously. Assert both wire
    // paths after that request exists, rather than racing its arrival.
    let requests = requests_after_extraction(&server).await;
    assert_eq!(requests.iter().filter(|r| r["tools"].is_array()).count(), 1);
    assert!(
        requests.iter().all(|r| r["model"] == "qwen3.7-plus"),
        "{requests:#?}"
    );
    assert!(
        requests
            .iter()
            .all(|r| r["tools"].is_array() || is_extraction(r)),
        "unexpected provider request: {requests:#?}"
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert_eq!(
        saved["models"], config["models"],
        "an implicit default was saved"
    );
    assert!(saved["system"]["butlerModel"].is_null());
    s.finish().await
}

fn is_extraction(request: &Value) -> bool {
    request["response_format"]["json_schema"]["name"] == "memory_meaning_v4"
}

async fn requests_after_extraction(
    server: &butler_e2e::e2e::fake_servers::FakeServer,
) -> Vec<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let requests = server.chat_requests();
            if requests.iter().any(is_extraction) {
                return requests;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("completed turn did not start semantic extraction")
}

/// DEFAULT-FALLBACK (#1193) — Deleting the model a conversation selected
/// never locks it: its controls, its next turn and a schedule posting into
/// it all run on the Settings default model.
#[tokio::test]
async fn deleted_session_model_falls_back_to_the_default() -> Result<(), HarnessError> {
    use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer};
    use butler_e2e::e2e::gateway::{TERMINAL, turn_state};
    use butler_e2e::e2e::{fixtures, scenario::turn_timeout};
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("DEFAULT-FALLBACK")?.fixture(Fixture::Empty);
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    let api = format!("{}/v1", server.base_url);
    let registered: Vec<Value> = ["qwen3.7-plus", "qwen3.8-max"]
        .iter()
        .map(|model| {
            json!({"provider_id":"qwen", "model_id":model, "auth_type":"api_key",
            "credential_id":"qwen-e2e", "api_base_url":api})
        })
        .collect();
    let config = json!({"models":{"registered":registered}});
    std::fs::write(
        setup.sandbox.data.join("butler.config.json"),
        config.to_string(),
    )?;
    std::fs::create_dir_all(setup.sandbox.data.join("auth"))?;
    std::fs::write(setup.sandbox.data.join("auth/model-provider-credentials.json"),
        json!({"credentials":[{"id":"qwen-e2e", "provider_id":"qwen", "auth_type":"api_key", "secret":"e2e-placeholder"}]}).to_string())?;
    let s = setup.start().await?;
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":"qwen/qwen3.7-plus", "access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let (_, turn) = s.turn("general", "Reply with one word.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let chosen =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"model":"qwen/qwen3.8-max"}),
        )
        .await?;
    assert_eq!(chosen.status, 200, "{}", chosen.text);
    let (_, turn) = s.turn("general", "Reply with one more word.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(
        turn_models(&server).last().map(String::as_str),
        Some("qwen3.8-max")
    );

    let deleted =
        s.gw.delete("/model-catalog/registered-models/qwen%2Fqwen3.8-max")
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    let controls = s.gw.get("/sessions/general/controls").await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    assert_eq!(
        controls.data()["controls"]["model"],
        "qwen/qwen3.7-plus",
        "{}",
        controls.text
    );
    let (_, turn) = s.turn("general", "Reply with one word again.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(
        turn_models(&server).last().map(String::as_str),
        Some("qwen3.7-plus")
    );

    let schedule =
        s.gw.post(
            "/automations",
            json!({"title":"E2E schedule", "prompt_body":"Reply with one scheduled word.",
                   "target_session_id":"general", "interval_seconds":3600}),
        )
        .await?;
    assert_eq!(schedule.status, 201, "{}", schedule.text);
    let id = schedule.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let run =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn_id = run.data()["run"]["turn_id"]
        .as_str()
        .unwrap_or_else(|| panic!("no turn for the run: {}", run.text))
        .to_owned();
    let timeout = std::time::Duration::from_secs(turn_timeout());
    let turn =
        s.gw.wait_turn("general", &turn_id, TERMINAL, timeout)
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(
        turn_models(&server).last().map(String::as_str),
        Some("qwen3.7-plus")
    );
    s.finish().await
}

/// The model of every turn request (the ones that offer tools), in order.
fn turn_models(server: &butler_e2e::e2e::fake_servers::FakeServer) -> Vec<String> {
    server
        .chat_requests()
        .iter()
        .filter(|request| request["tools"].is_array())
        .filter_map(|request| request["model"].as_str().map(str::to_owned))
        .collect()
}
