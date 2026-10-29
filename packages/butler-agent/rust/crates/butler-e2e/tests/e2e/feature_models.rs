//! Feature model routing through real gateways and local stub providers.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    provider::title_response,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

const MAIN: &str = "openai/gpt-6-sol";
const FEATURE: &str = "openai/gpt-6-luna";

async fn register(s: &Scenario) -> Result<(), HarnessError> {
    for model in [MAIN, FEATURE] {
        let reply =
            s.gw.post(
                "/model-catalog/registered-models",
                json!({
                    "provider_id":"openai", "model_id":model, "auth_type":"chatgpt_oauth"
                }),
            )
            .await?;
        assert!(reply.status < 300, "{}", reply.text);
    }
    Ok(())
}

// Explicit schedule selection and omitted/deleted-model chat fallback are covered
// by schedule_model::{sched_model_01_create_selects_model,
// sched_model_03_deleted_and_omitted_models_inherit_chat}. Consolidation setting
// persistence is covered by memory_consolidation::consolidation_model_and_reasoning_survive_restart.
#[tokio::test]
async fn schedules_consolidation_and_chat_inherit_main_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new("FEATURE-MODEL-FALLBACK")?
        .stub_cassette(cassette)
        .env("BUTLER_MEMORY_SYNC_TRACE", "1");
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    register(&s).await?;
    s.provider()?.set_chat_responder(|request| {
        super::briefing_effort::briefing(request).or_else(|| Some(title_response("Done.")))
    });
    assert_eq!(
        s.gw.settings().await?["effective_consolidation_model"],
        MAIN
    );
    consolidation(&s, MAIN).await?;
    schedule(&s, MAIN).await?;
    // One feature's explicit choice must not change another feature's fallback.
    s.patch_settings(json!({"consolidation_model":FEATURE}), "memory model")
        .await?;
    assert_eq!(
        s.gw.settings().await?["effective_consolidation_model"],
        FEATURE
    );
    consolidation(&s, FEATURE).await?;
    schedule(&s, MAIN).await?;
    s.patch_settings(
        json!({"consolidation_model":"default"}),
        "inherit memory model",
    )
    .await?;
    assert_eq!(
        s.gw.settings().await?["effective_consolidation_model"],
        MAIN
    );
    consolidation(&s, MAIN).await?;
    let before = s.provider()?.requests().len();
    let (_, turn) = s.turn("general", "Reply with one word.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let chat: Vec<_> = requests[before..]
        .iter()
        .filter(|r| r["tools"].is_array())
        .collect();
    assert!(!chat.is_empty(), "chat made no request");
    assert!(
        chat.iter()
            .all(|r| r["model"] == MAIN.strip_prefix("openai/").unwrap()),
        "{chat:?}"
    );
    s.finish().await
}

async fn schedule(s: &Scenario, expected: &str) -> Result<(), HarnessError> {
    let before = s.provider()?.requests().len();
    let body = json!({"title":"Feature fallback", "prompt_body":"Reply with one word.",
        "target_session_id":"general", "interval_seconds":3600});
    let reply = s.gw.post("/automations", body).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let id = reply.data()["automation"]["id"].as_str().unwrap();
    let reply =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_eq!(reply.data()["run"]["state"], "succeeded", "{}", reply.text);
    let id = reply.data()["run"]["turn_id"].as_str().unwrap();
    let turn =
        s.gw.wait_terminal("general", id, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let turns: Vec<_> = requests[before..]
        .iter()
        .filter(|r| r["tools"].is_array())
        .collect();
    assert_ne!(turns, [] as [&Value; 0]);
    assert!(
        turns
            .iter()
            .all(|r| r["model"] == expected.strip_prefix("openai/").unwrap()),
        "{turns:?}"
    );
    Ok(())
}

async fn consolidation(s: &Scenario, expected: &str) -> Result<(), HarnessError> {
    // A manual operation admits once after the consumer releases its writer.
    super::memory_fixture::settle(&s.sandbox.data).await?;
    super::memory_fixture::wait_parked(s).await;
    let before = s.provider()?.requests().len();
    let reply =
        s.gw.post(
            "/memory/consolidation",
            json!({"operation_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let id = reply.data()["operation_id"].clone();
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let events = s.gw.events_since(0).await?;
            if let Some(done) = events.iter().find(|event| {
                event["type"] == "memory.operation"
                    && event["payload"]["operation_id"] == id
                    && matches!(
                        event["payload"]["phase"].as_str(),
                        Some("complete" | "failed")
                    )
            }) {
                assert_eq!(done["payload"]["phase"], "complete", "{done}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("consolidation finished")?;
    let requests = s.provider()?.requests();
    let briefings: Vec<_> = requests[before..]
        .iter()
        .filter(|r| super::briefing_effort::briefing_task(r))
        .collect();
    assert!(
        !briefings.is_empty(),
        "consolidation made no briefing request"
    );
    assert!(
        briefings
            .iter()
            .all(|r| r["model"] == expected.strip_prefix("openai/").unwrap()),
        "{briefings:?}"
    );
    Ok(())
}

#[tokio::test]
async fn worker_profile_choice_preserves_parent_and_default_models() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for explicit in [false, true] {
        let (s, script, server) = super::worker_cap::setup("FEATURE-WORKER-MODEL", 3).await?;
        register(&s).await?;
        let settings = s.gw.settings().await?;
        assert_eq!(settings["worker_profiles"][0]["model"], MAIN);
        if explicit {
            let mut profiles = settings["worker_profiles"].clone();
            profiles[0]["model"] = FEATURE.into();
            s.patch_settings(json!({"worker_profiles":profiles}), "worker model")
                .await?;
        }
        s.gw.say("general", "Verify batch red").await?;
        let (_, workers) = super::worker_cap::workers(&s, "general", 3).await?;
        for index in 0..3 {
            script.release(&format!("red-{index}"));
        }
        super::worker_cap::started(&script, 3).await;
        for worker in &workers {
            super::worker_cap::closed(&s, worker["session_id"].as_str().unwrap()).await?;
        }
        let requests = script.requests.lock().unwrap().clone();
        for role in ["parent", "steward", "worker"] {
            let requests: Vec<_> = requests.iter().filter(|(kind, _)| kind == role).collect();
            assert!(!requests.is_empty(), "no {role} request");
            let expected = if role == "worker" && explicit {
                FEATURE
            } else {
                MAIN
            };
            assert!(
                requests
                    .iter()
                    .all(|(_, body)| body["model"] == expected.strip_prefix("openai/").unwrap()),
                "{requests:?}"
            );
        }
        s.finish().await?;
        server.abort();
    }
    Ok(())
}
