//! One background choice across schedules, memory upkeep and delegated work.
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
const BACKGROUND: &str = "openai/gpt-6-luna";

async fn register(s: &Scenario) -> Result<(), HarnessError> {
    for model in [MAIN, BACKGROUND] {
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

#[tokio::test]
async fn schedules_consolidation_and_chat_follow_background_precedence() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for selection in [None, Some(BACKGROUND), Some("default")] {
        let mut cassette = Cassette::load("TOOL-01")?;
        cassette.exchanges.clear();
        let setup = Setup::new("BACKGROUND-MODEL")?.stub_cassette(cassette);
        super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
        let s = setup.start().await?;
        register(&s).await?;
        s.provider()?.set_chat_responder(|request| {
            super::briefing_effort::briefing(request).or_else(|| Some(title_response("Done.")))
        });
        if let Some(selection) = selection {
            // Exercise clearing an existing selection, not only an empty setting.
            s.patch_settings(json!({"background_model":BACKGROUND}), "background model")
                .await?;
            s.patch_settings(json!({"background_model":selection}), "background model")
                .await?;
        }
        let expected = if selection == Some(BACKGROUND) {
            BACKGROUND
        } else {
            MAIN
        };
        let settings = s.gw.settings().await?;
        assert_eq!(settings["effective_background_model"], expected);
        assert_eq!(settings["effective_consolidation_model"], expected);
        assert_eq!(
            settings["background_model"],
            if expected == BACKGROUND {
                json!(BACKGROUND)
            } else {
                Value::Null
            }
        );
        let config: Value =
            serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
        if selection.is_some() {
            assert_eq!(
                config["system"]["backgroundModel"],
                settings["background_model"]
            );
        }
        consolidation(&s, expected).await?;
        s.patch_settings(json!({"consolidation_model":MAIN}), "explicit memory model")
            .await?;
        assert_eq!(
            s.gw.settings().await?["effective_consolidation_model"],
            MAIN
        );
        consolidation(&s, MAIN).await?;
        schedule(&s, None, expected).await?;
        schedule(&s, Some(MAIN), MAIN).await?;
        let before = s.provider()?.requests().len();
        let (_, turn) = s.turn("general", "Reply with one word.").await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let requests = s.provider()?.requests();
        let chat: Vec<_> = requests[before..]
            .iter()
            .filter(|r| r["tools"].is_array())
            .collect();
        assert_ne!(chat, [] as [&Value; 0]);
        assert!(
            chat.iter()
                .all(|r| r["model"] == MAIN.strip_prefix("openai/").unwrap()),
            "{chat:?}"
        );
        s.finish().await?;
    }
    Ok(())
}

async fn schedule(
    s: &Scenario,
    explicit: Option<&str>,
    expected: &str,
) -> Result<(), HarnessError> {
    let before = s.provider()?.requests().len();
    let mut body = json!({"title":"Background check", "prompt_body":"Reply with one word.",
        "target_session_id":"general", "interval_seconds":3600});
    if let Some(model) = explicit {
        body["model"] = model.into();
    }
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
async fn delegated_stewards_and_workers_follow_background_and_explicit_profiles()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (selection, explicit) in [
        (None, false),
        (Some(BACKGROUND), false),
        (Some(BACKGROUND), true),
        (Some("default"), false),
    ] {
        let background = selection == Some(BACKGROUND);
        let (s, script, server) = super::worker_cap::setup("BACKGROUND-CHILDREN", 3).await?;
        register(&s).await?;
        if let Some(selection) = selection {
            s.patch_settings(json!({"background_model":BACKGROUND}), "background")
                .await?;
            s.patch_settings(json!({"background_model":selection}), "background")
                .await?;
        }
        let settings = s.gw.settings().await?;
        let mut profiles = settings["worker_profiles"].clone();
        profiles[0]["model"] = MAIN.into();
        profiles[0]["model_explicit"] = true.into();
        if explicit {
            s.patch_settings(json!({"worker_profiles":profiles}), "explicit worker")
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
        let expected = if background { BACKGROUND } else { MAIN };
        for role in ["steward", "worker"] {
            let requests: Vec<_> = requests.iter().filter(|(kind, _)| kind == role).collect();
            assert_ne!(requests, [] as [&(String, Value); 0]);
            let expected = if role == "worker" && explicit {
                MAIN
            } else {
                expected
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

#[tokio::test]
async fn invalid_background_choices_are_rejected_and_removed_choices_are_retained()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BACKGROUND-VALIDATION")?
        .cassette("TOOL-01")
        .start()
        .await?;
    register(&s).await?;
    for model in ["openai/unknown-model", "openai/gpt-image-2"] {
        let reply =
            s.gw.patch("/settings", json!({"background_model":model}))
                .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert!(
            reply.text.contains("settings_model_unavailable"),
            "{}",
            reply.text
        );
    }
    s.patch_settings(json!({"background_model":BACKGROUND}), "background")
        .await?;
    let reply =
        s.gw.delete("/model-catalog/registered-models/openai%2Fgpt-6-luna")
            .await?;
    assert!(reply.status < 300, "{}", reply.text);
    let settings = s.gw.settings().await?;
    assert_eq!(settings["background_model"], BACKGROUND);
    assert_eq!(settings["effective_background_model"], MAIN);
    s.finish().await
}

#[tokio::test]
async fn profile_extraction_uses_background_and_preserves_explicit_model()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let s = Setup::new("BACKGROUND-PROFILE")?
        .stub_cassette(cassette)
        .start()
        .await?;
    register(&s).await?;
    s.provider()?
        .set_chat_responder(|_| Some(title_response(r#"{"candidates":[]}"#)));
    let reply =
        s.gw.patch("/personalization", json!({"profiling":{"mode":"basic"}}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    for (index, selection) in [None, Some(BACKGROUND), Some("default")]
        .into_iter()
        .enumerate()
    {
        if let Some(selection) = selection {
            s.patch_settings(json!({"background_model":selection}), "background")
                .await?;
        }
        let expected = if selection == Some(BACKGROUND) {
            BACKGROUND
        } else {
            MAIN
        };
        profile_import(
            &s,
            &format!("Prefer concise replies, source {index}."),
            expected,
        )
        .await?;
    }
    s.patch_settings(
        json!({"background_model":BACKGROUND, "consolidation_model":MAIN}),
        "explicit profile model",
    )
    .await?;
    profile_import(
        &s,
        "Prefer concise replies from the selected extractor.",
        MAIN,
    )
    .await?;
    s.patch_settings(
        json!({"consolidation_model":"default"}),
        "inherit profile model",
    )
    .await?;
    let removed =
        s.gw.delete("/model-catalog/registered-models/openai%2Fgpt-6-luna")
            .await?;
    assert!(removed.status < 300, "{}", removed.text);
    profile_import(&s, "Prefer concise replies after a model is removed.", MAIN).await?;
    assert_eq!(s.gw.settings().await?["background_model"], BACKGROUND);
    s.finish().await
}

async fn profile_import(s: &Scenario, text: &str, expected: &str) -> Result<(), HarnessError> {
    let before = s.provider()?.requests().len();
    let reply =
        s.gw.post("/personalization/profile-import", json!({"text":text}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["model_called"], true, "{}", reply.text);
    let requests = s.provider()?.requests();
    let imports = &requests[before..];
    assert_eq!(imports.len(), 1, "{imports:?}");
    assert_eq!(
        imports[0]["model"],
        expected.strip_prefix("openai/").unwrap(),
        "{imports:?}"
    );
    Ok(())
}
