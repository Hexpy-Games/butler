//! N. Automations (SCENARIOS.md AUTO-01). The automation's prompt is the
//! TURN-01 request, so its recording is replayed (never re-recorded here).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup, turn_timeout};
use serde_json::{Value, json};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

async fn create(s: &Scenario) -> Result<String, HarnessError> {
    let created = s
        .gw
        .post(
            "/automations",
            json!({"title": "Numbers", "prompt_body": NUMBERS, "target_session_id": "general", "interval_seconds": 3600}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    Ok(created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

async fn runs(s: &Scenario, id: &str) -> Result<Vec<Value>, HarnessError> {
    let reply = s.gw.get(&format!("/automations/{id}/runs")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["runs"].as_array().cloned().unwrap_or_default())
}

async fn listed(s: &Scenario, id: &str) -> Result<Option<Value>, HarnessError> {
    let reply = s.gw.get("/automations").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["automations"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|automation| automation["id"] == id)
        .cloned())
}

async fn run_now(s: &Scenario, id: &str) -> Result<String, HarnessError> {
    let run =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}\n{}", run.text, s.agent.logs());
    Ok(run.data()["run"]["turn_id"].as_str().unwrap().to_owned())
}

async fn dispatch_due(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let due = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(due.status, 202, "{}", due.text);
    Ok(due.data()["runs"].as_array().cloned().unwrap_or_default())
}

/// AUTO-01 — An automation run delivers a turn and leaves one run record;
/// a not-yet-due automation is not dispatched; deleting it while its run
/// streams leaves nothing scheduled; a restart adds no run and no turn.
#[tokio::test]
async fn auto_01_automation_runs_a_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("AUTO-01")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let id = create(&s).await?;
    assert!(
        dispatch_due(&s).await?.is_empty(),
        "an automation ran before it was due"
    );
    assert!(s.gw.messages("general").await?.is_empty());

    let turn_id = run_now(&s, &id).await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let messages = s.gw.messages("general").await?;
    assert!(
        messages.iter().any(|m| m["role"] == "user"
            && m["turn_id"] == turn_id.as_str()
            && m["text"] == NUMBERS),
        "automation prompt not in the chat: {messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["turn_id"] == turn_id.as_str()),
        "no answer for the automation turn"
    );
    let recorded = runs(&s, &id).await?;
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert_eq!(recorded[0]["turn_id"], turn_id.as_str());
    let summary = listed(&s, &id).await?.expect("automation listed");
    assert_eq!(summary["run_count"], 1, "{summary}");

    // Delete while the second run's answer is still streaming.
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 400,
        min_ms: 150,
    });
    let second = run_now(&s, &id).await?;
    let deleted = s.gw.delete(&format!("/automations/{id}")).await?;
    assert!(deleted.status < 300, "{}", deleted.text);
    let turn =
        s.gw.wait_terminal("general", &second, Duration::from_secs(turn_timeout()))
            .await?;
    assert_ne!(turn_state(&turn), "runtime_fault", "{turn}");
    assert!(
        listed(&s, &id).await?.is_none(),
        "deleted automation still listed"
    );
    assert!(dispatch_due(&s).await?.is_empty());
    let turns = s.gw.turns("general").await?.len();
    let messages = s.gw.messages("general").await?.len();

    s.restart().await?;
    assert!(
        listed(&s, &id).await?.is_none(),
        "deleted automation came back"
    );
    assert!(
        dispatch_due(&s).await?.is_empty(),
        "restart dispatched a run"
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        s.gw.turns("general").await?.len(),
        turns,
        "restart started a turn"
    );
    assert_eq!(s.gw.messages("general").await?.len(), messages);
    s.finish().await
}

/// Internal schedule failures retain their cause in the server log only.
#[tokio::test]
async fn auto_02_internal_failure_is_logged_and_private() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AUTO-02")?.start().await?;
    let id = create(&s).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .expect("open isolated App database");
    db.execute_batch(
        "CREATE TRIGGER fail_schedule_run BEFORE INSERT ON app_automation_runs
         BEGIN SELECT RAISE(ABORT, 'schedule-run-diagnostic-sentinel'); END;",
    )
    .expect("inject schedule storage failure");
    let reply =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(reply.status, 500, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("internal_error"));
    assert_eq!(reply.body["error"]["message"], "Request failed.");
    assert!(!reply.text.contains("schedule-run-diagnostic-sentinel"));
    let logs = s.agent.logs();
    assert!(logs.contains("app_sqlite_error"), "{logs}");
    assert!(logs.contains("schedule-run-diagnostic-sentinel"), "{logs}");
    drop(db);
    s.finish().await
}

/// AUTO-01 — `butler automation run ID` runs an automation created in the App.
#[tokio::test]
#[ignore = "product gap: AUTO-01-CLI — the automation CLI reads a different store than the App: after POST /automations (201), `butler automation list --json` returns no automations and `butler automation run ID` fails `invalid_state: automation <id> not found`"]
async fn auto_01_cli_runs_an_app_automation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AUTO-01-CLI")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let id = create(&s).await?;
    let list = s
        .agent
        .cli_async(&["automation", "list", "--json"])
        .await?
        .json()?;
    assert!(
        list.to_string().contains(&id),
        "CLI does not list it: {list}"
    );
    let run = s
        .agent
        .cli_async(&["automation", "run", &id, "--json"])
        .await?;
    assert_eq!(run.code, Some(0), "{} {}", run.stdout, run.stderr);
    let recorded = runs(&s, &id).await?;
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    let turn_id = recorded[0]["turn_id"].as_str().unwrap().to_owned();
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    s.finish().await
}
