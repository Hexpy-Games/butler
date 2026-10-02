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
    assert!(!requests.is_empty());
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
