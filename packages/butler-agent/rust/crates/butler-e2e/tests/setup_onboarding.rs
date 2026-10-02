//! First-run setup (#230): the onboarding state the App keeps in the agent
//! (`settings.onboarding`), and the default model before one is chosen
//! (the connected provider's routine preset, never the top model at xhigh).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::scenario::{Fixture, Setup};
use serde_json::{Value, json};

const ACCEPTED_AT: &str = "2026-09-28T01:02:03.456Z";
const COMPLETED_AT: &str = "2026-09-28T01:05:00.000Z";

/// SETUP-11 — The onboarding state starts empty, takes partial updates
/// (absent fields kept, `null` clears), rejects malformed values without
/// changing anything, reaches live listeners and survives a restart.
#[tokio::test]
async fn setup_11_onboarding_state_lives_in_the_agent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SETUP-11")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    let empty = json!({"consent_version": null, "accepted_at": null, "completed_at": null});
    assert_eq!(s.gw.settings().await?["onboarding"], empty);

    for bypass in [
        json!({"onboarding":{"consent_version":2}}),
        json!({"onboarding":{"consent_version":2,"completed_at":COMPLETED_AT}}),
    ] {
        let rejected = s.gw.patch("/settings", bypass).await?;
        assert_eq!(rejected.status, 400, "consent recorded without acceptance");
        assert_eq!(s.gw.settings().await?["onboarding"], empty);
    }
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let consent =
        s.gw.patch(
            "/settings",
            json!({"onboarding": {"consent_version": 1, "accepted_at": ACCEPTED_AT}}),
        )
        .await?;
    assert_eq!(consent.status, 200, "{}", consent.text);
    let accepted = json!({"consent_version": 1, "accepted_at": ACCEPTED_AT, "completed_at": null});
    assert_eq!(consent.data()["onboarding"], accepted);
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "settings.updated"
            && event["payload"]["settings"]["onboarding"]["consent_version"] == 1
    })
    .await?;

    // Completion is saved together with the model choice, as the App does.
    let complete =
        s.gw.patch(
            "/settings",
            json!({"language": "ko", "onboarding": {"completed_at": COMPLETED_AT}}),
        )
        .await?;
    assert_eq!(complete.status, 200, "{}", complete.text);
    let finished =
        json!({"consent_version": 1, "accepted_at": ACCEPTED_AT, "completed_at": COMPLETED_AT});
    assert_eq!(complete.data()["onboarding"], finished);

    let before = s.gw.get("/settings").await?.text;
    for malformed in [
        json!({"onboarding": {"consent_version": "2"}}),
        json!({"onboarding": {"consent_version": -1}}),
        json!({"onboarding": {"completed_at": "yesterday"}}),
        json!({"onboarding": {"completed": COMPLETED_AT}}),
        json!({"onboarding": null}),
    ] {
        let reply = s.gw.patch("/settings", malformed.clone()).await?;
        assert_eq!(reply.status, 400, "{malformed}: {}", reply.text);
        assert_eq!(reply.error_code(), Some("invalid_settings_request"));
    }
    assert_eq!(
        s.gw.get("/settings").await?.text,
        before,
        "a rejected PATCH changed settings"
    );

    s.restart().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(settings["onboarding"], finished);
    assert_eq!(settings["language"], "ko");

    // A newer consent version is recorded without touching completion.
    let bumped =
        s.gw.patch("/settings", json!({"onboarding": {"consent_version": 2}}))
            .await?;
    assert_eq!(bumped.data()["onboarding"]["consent_version"], 2);
    assert_eq!(bumped.data()["onboarding"]["completed_at"], COMPLETED_AT);
    let cleared =
        s.gw.patch("/settings", json!({"onboarding":{"accepted_at":null}}))
            .await?;
    assert_eq!(cleared.status, 400);
    assert_eq!(
        s.gw.settings().await?["onboarding"]["accepted_at"],
        ACCEPTED_AT
    );
    s.finish().await
}

/// The routine preset (`model`, `effort`) the catalog offers for
/// `provider`: `providers[].presets.routine`, else the worker preset's
/// `routine_work` (a catalog without provider presets).
fn routine_preset(catalog: &Value, provider: &str) -> (String, String) {
    let find = |list: &str| {
        catalog[list]
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| entry["provider_id"] == provider)
            .cloned()
    };
    if let Some(routine) = find("providers").map(|entry| entry["presets"]["routine"].clone())
        && routine.is_object()
    {
        return (
            routine["model"].as_str().unwrap().to_owned(),
            routine["effort"].as_str().unwrap().to_owned(),
        );
    }
    let preset = find("worker_model_presets").unwrap_or_else(|| panic!("no preset for {provider}"));
    let routine = &preset["routine_work"];
    (
        routine["model"].as_str().unwrap().to_owned(),
        routine["reasoning_effort"].as_str().unwrap().to_owned(),
    )
}

/// SETUP-12 — Before a model is chosen, the default is the routine preset:
/// OpenAI's on a fresh install, the connected provider's once one is
/// connected, at the preset's effort (not xhigh).
#[tokio::test]
async fn setup_12_default_model_is_the_connected_providers_routine_preset()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SETUP-12")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    let catalog = s.gw.get("/model-catalog").await?.data().clone();
    let (openai_model, openai_effort) = routine_preset(&catalog, "openai");
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], openai_model.as_str(), "{settings}");
    assert_eq!(settings["reasoning_effort"], openai_effort.as_str());
    assert_ne!(settings["reasoning_effort"], "xhigh");

    let (claude_model, claude_effort) = routine_preset(&catalog, "anthropic");
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id": "anthropic", "api_key": "sk-ant-e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let model_id = claude_model.strip_prefix("anthropic/").unwrap();
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id": "anthropic", "model_id": model_id, "auth_type": "api_key",
                   "credential_id": saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], claude_model.as_str(), "{settings}");
    assert_eq!(settings["reasoning_effort"], claude_effort.as_str());
    s.finish().await
}

/// SETUP-13 — Owner decision (#279 review): the routine-preset default is
/// for new installs only. An install from before it (its App database has
/// no recorded default policy) that never chose a model keeps the default
/// it has been running with; a model the user then saves is what it uses,
/// across a restart.
#[tokio::test]
async fn setup_13_existing_install_keeps_its_default_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SETUP-13")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    let catalog = s.gw.get("/model-catalog").await?.data().clone();
    let (routine_model, _) = routine_preset(&catalog, "openai");
    assert_eq!(s.gw.settings().await?["model"], routine_model.as_str());

    // The App database as the release before #230 left it.
    s.agent.terminate().await?;
    {
        let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
            .unwrap();
        db.execute(
            "DELETE FROM app_settings WHERE key='default-model-policy'",
            [],
        )
        .unwrap();
    }
    s.gw = s.agent.start_again().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], "openai/gpt-5.5", "{settings}");
    let legacy = catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["model_ref"] == "openai/gpt-5.5")
        .unwrap();
    assert_eq!(
        settings["reasoning_effort"], legacy["default_reasoning_effort"],
        "{settings}"
    );

    let chosen =
        s.gw.patch(
            "/settings",
            json!({"model": "openai/gpt-6-luna", "reasoning_effort": "medium"}),
        )
        .await?;
    assert_eq!(chosen.status, 200, "{}", chosen.text);
    s.restart().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], "openai/gpt-6-luna", "{settings}");
    assert_eq!(settings["reasoning_effort"], "medium", "{settings}");
    s.finish().await
}
