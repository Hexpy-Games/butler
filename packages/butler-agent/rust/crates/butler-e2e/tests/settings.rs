//! B. Settings & model selection (SCENARIOS.md SET-01, SET-02, SET-03, SET-05).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::Setup;
use serde_json::{Value, json};

fn controls(turn: &Value) -> (&str, &str) {
    (
        turn["execution_controls"]["model_ref"]
            .as_str()
            .unwrap_or_default(),
        turn["execution_controls"]["reasoning_effort"]
            .as_str()
            .unwrap_or_default(),
    )
}

/// SET-01 — Changing the model in Settings applies to the next turn.
#[tokio::test]
async fn set_01_model_change_applies_to_next_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SET-01")?.cassette("SET-01").start().await?;
    assert_eq!(s.gw.settings().await?["model"], "openai/gpt-6-sol");
    let live = LiveEvents::subscribe(&s.gw, 0).await?;

    let reply =
        s.gw.patch(
            "/settings",
            json!({"model": "openai/gpt-6-luna", "reasoning_effort": "max"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["model"], "openai/gpt-6-luna");
    assert_eq!(reply.data()["reasoning_effort"], "max");
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], "openai/gpt-6-luna");
    assert_eq!(settings["reasoning_effort"], "max");
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "settings.updated"
            && event["payload"]["settings"]["model"] == "openai/gpt-6-luna"
            && event["payload"]["settings"]["reasoning_effort"] == "max"
    })
    .await?;

    let (_, turn) = s
        .turn("general", "Reply with exactly the word: luna-check")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(controls(&turn), ("openai/gpt-6-luna", "max"), "{turn}");

    s.restart().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], "openai/gpt-6-luna");
    assert_eq!(settings["reasoning_effort"], "max");
    // The delivered turn keeps the model it ran with.
    let turns = s.gw.turns("general").await?;
    assert_eq!(controls(&turns[0]), ("openai/gpt-6-luna", "max"));
    s.finish().await
}

/// SET-01 (CLI part) — `butler model status` agrees with Settings.
#[tokio::test]
#[ignore = "product gap: SET-01-CLI — PATCH /settings stores the model in the App DB; `butler model status` reads system.defaultModel from butler.config.json and keeps reporting the old model"]
async fn set_01_cli_model_status_agrees_with_settings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SET-01-CLI")?.start().await?;
    let reply =
        s.gw.patch(
            "/settings",
            json!({"model": "openai/gpt-6-luna", "reasoning_effort": "max"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let status = s.agent.cli(&["model", "status", "--json"])?.json()?;
    assert_eq!(status["data"]["modelRef"], "openai/gpt-6-luna", "{status}");
    s.finish().await
}

/// SET-02 — Unavailable model and malformed settings are rejected.
#[tokio::test]
async fn set_02_unavailable_and_malformed_settings_are_rejected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SET-02")?.cassette("SET-02").start().await?;
    let before = s.gw.get("/settings").await?.text;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let baseline_updates = count_settings_updates(&live);

    for field in ["model", "consolidation_model"] {
        for model in ["openai/gpt-0", "anthropic/claude-opus-4-7"] {
            let reply = s.gw.patch("/settings", json!({ field: model })).await?;
            assert_eq!(reply.status, 400, "{field}={model}: {}", reply.text);
            assert_eq!(
                reply.error_code(),
                Some("settings_model_unavailable"),
                "{}",
                reply.text
            );
            let message = reply.body["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase();
            assert!(
                message.contains("model"),
                "message should name the model field: {message}"
            );
        }
    }

    assert_malformed_settings_rejected(&s.gw).await?;

    assert_eq!(
        s.gw.get("/settings").await?.text,
        before,
        "rejected PATCHes changed settings"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        count_settings_updates(&live),
        baseline_updates,
        "rejected PATCH emitted settings.updated"
    );
    s.restart().await?;
    assert_eq!(
        s.gw.get("/settings").await?.text,
        before,
        "settings changed across restart"
    );

    let (_, turn) = s
        .turn("general", "Reply with exactly the word: still-sol")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(controls(&turn), ("openai/gpt-6-sol", "low"));
    s.finish().await
}

/// SET-02: unknown fields, wrong types, invalid JSON and an oversize body
/// are rejected with their public error codes.
async fn assert_malformed_settings_rejected(gw: &Gateway) -> Result<(), HarnessError> {
    let reply = gw
        .patch("/settings", json!({"no_such_setting": true}))
        .await?;
    assert_eq!(
        (reply.status, reply.error_code()),
        (400, Some("invalid_settings_request")),
        "{}",
        reply.text
    );
    let reply = gw
        .patch("/settings", json!({"consolidation_reasoning_effort": 7}))
        .await?;
    assert_eq!(
        (reply.status, reply.error_code()),
        (400, Some("invalid_settings_request")),
        "{}",
        reply.text
    );
    let reply = gw
        .send(
            reqwest::Method::PATCH,
            "/settings",
            Some("{not json".into()),
        )
        .await?;
    assert_eq!(
        (reply.status, reply.error_code()),
        (400, Some("invalid_json")),
        "{}",
        reply.text
    );
    let oversize = format!("{{\"language\":\"{}\"}}", "x".repeat(1024 * 1024 + 1024));
    let reply = gw
        .send(reqwest::Method::PATCH, "/settings", Some(oversize))
        .await?;
    assert_eq!(reply.status, 413, "{}", reply.text);
    Ok(())
}

fn count_settings_updates(live: &LiveEvents) -> usize {
    live.snapshot()
        .iter()
        .filter(|event| event["type"] == "settings.updated")
        .count()
}

/// SET-03 — Per-message model override does not change settings.
#[tokio::test]
async fn set_03_per_message_override_leaves_settings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SET-03")?.cassette("SET-03").start().await?;
    let before = s.gw.settings().await?;
    let accepted =
        s.gw.send_message(json!({
            "chat_id": "general",
            "text": "Reply with exactly the word: override-check",
            "client_message_id": uuid::Uuid::new_v4().to_string(),
            "model": "openai/gpt-6-luna",
            "reasoning_effort": "max",
        }))
        .await?;
    let turn_id = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(controls(&turn), ("openai/gpt-6-luna", "max"));
    let after = s.gw.settings().await?;
    assert_eq!(after["model"], before["model"]);
    assert_eq!(after["reasoning_effort"], before["reasoning_effort"]);

    // Another session still runs on the unchanged global default.
    let other =
        s.gw.post("/sessions", json!({"kind": "chat", "title": "other"}))
            .await?;
    let other_id = other.data()["session"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (_, turn) = s
        .turn(&other_id, "Reply with exactly the word: default-check")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(controls(&turn), ("openai/gpt-6-sol", "low"));

    let turns_before = s.gw.turns("general").await?.len();
    let reply =
        s.gw.post(
            "/messages",
            json!({"chat_id": "general", "text": "unavailable", "model": "openai/gpt-0",
                   "client_message_id": uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert!(
        (400..500).contains(&reply.status),
        "unavailable override: {} {}",
        reply.status,
        reply.text
    );
    assert_eq!(
        s.gw.turns("general").await?.len(),
        turns_before,
        "a turn was created"
    );
    s.finish().await
}

/// SET-03 (same-session part) — the next plain message returns to Settings.
#[tokio::test]
#[ignore = "product gap: SET-03-STICKY — a per-message model override is persisted as the session's controls (source session_override), so the next plain message in that session keeps the override instead of the Settings model; needs an owner decision"]
async fn set_03_override_does_not_stick_to_next_message() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SET-03-STICKY")?
        .cassette("SET-03-STICKY")
        .start()
        .await?;
    let accepted =
        s.gw.send_message(json!({
            "chat_id": "general",
            "text": "Reply with exactly the word: override-check",
            "client_message_id": uuid::Uuid::new_v4().to_string(),
            "model": "openai/gpt-6-luna",
            "reasoning_effort": "max",
        }))
        .await?;
    let turn_id = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
        .await?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: default-check")
        .await?;
    assert_eq!(controls(&turn), ("openai/gpt-6-sol", "low"), "{turn}");
    s.finish().await
}

/// SET-05 — Concurrent settings edits do not lose updates.
#[tokio::test]
async fn set_05_concurrent_settings_edits_keep_every_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SET-05")?.start().await?;
    let patches = vec![
        json!({"language": "ko"}),
        json!({"timezone": "Europe/Berlin"}),
        json!({"appearance_theme": "dark"}),
        json!({"translucent_sidebar": false}),
        json!({"consolidation_reasoning_effort": "high"}),
        json!({"plan_mode_default": true}),
        json!({"max_simultaneous_workers": 3}),
        json!({"follow_up_behavior": "steer"}),
        json!({"diagnostics_enabled": true}),
        json!({"desktop_tray_enabled": false}),
    ];
    let mut tasks = Vec::new();
    for round in 0..2 {
        for patch in &patches {
            let gw = s.gw.clone();
            let patch = patch.clone();
            tasks.push(tokio::spawn(async move {
                let _ = round;
                gw.patch("/settings", patch).await
            }));
        }
    }
    for task in tasks {
        let reply = task
            .await
            .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))??;
        assert!(
            reply.status < 500,
            "5xx on concurrent PATCH: {}",
            reply.text
        );
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    let check = |settings: &Value| {
        for patch in &patches {
            for (key, value) in patch.as_object().unwrap() {
                assert_eq!(&settings[key], value, "lost update for {key}: {settings}");
            }
        }
    };
    check(&s.gw.settings().await?);
    let config: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert!(config.is_object());
    s.restart().await?;
    check(&s.gw.settings().await?);
    s.finish().await
}
