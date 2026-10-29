//! User-facing consolidation settings, local schedule and explicit operations.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use super::briefing_effort::{briefing, briefing_task};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

mod busy;
mod timezone;
mod wake_catchup;

async fn setup(id: &str) -> Result<(Scenario, String), HarnessError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new(id)?
        .stub_cassette(cassette)
        .env("TZ", "UTC")
        .env("BUTLER_E2E_APP_NOW", "2026-10-02T03:59:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address);
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(briefing);
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
    super::memory_fixture::arm_consolidation(&s.sandbox.data, "2026-10-02T03:59:00.000Z")?;
    Ok((s, address))
}

async fn clock(address: &str, now: &str) -> Result<Value, HarnessError> {
    let mut stream = tokio::net::TcpStream::connect(address).await?;
    stream.write_all(format!("{now}\n").as_bytes()).await?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).await?;
    Ok(serde_json::from_str(&line)?)
}

async fn settled(address: &str) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if clock(address, "").await?["context_reads"]
                .as_u64()
                .unwrap_or(0)
                >= 2
            {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("maintenance tick settled")
}

fn state(s: &Scenario) -> Value {
    std::fs::read(
        s.sandbox
            .data
            .join("state/scheduler/consolidation-cycle.json"),
    )
    .ok()
    .and_then(|b| serde_json::from_slice(&b).ok())
    .unwrap_or(Value::Null)
}
fn calls(s: &Scenario) -> usize {
    s.provider()
        .unwrap()
        .requests()
        .iter()
        .filter(|r| briefing_task(r))
        .count()
}

pub(crate) async fn terminal(
    s: &Scenario,
    trigger: &str,
    phase: &str,
) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let events = s.gw.events_since(0).await?;
            let matching: Vec<_> = events
                .iter()
                .filter(|e| {
                    e["type"] == "memory.operation"
                        && e["payload"]["kind"] == "consolidation"
                        && e["payload"]["trigger"] == trigger
                })
                .collect();
            if let Some(done) = matching.iter().find(|e| e["payload"]["phase"] == phase) {
                let id = &done["payload"]["operation_id"];
                let running = matching
                    .iter()
                    .find(|e| {
                        e["payload"]["operation_id"] == *id && e["payload"]["phase"] == "running"
                    })
                    .expect("running event precedes completion");
                assert_eq!(running["payload"]["sequence"], 1);
                assert_eq!(done["payload"]["sequence"], 2);
                return Ok(done["payload"].clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("consolidation terminal event")
}

async fn completed_calls(s: &Scenario, count: usize) {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let events = s.gw.events_since(0).await.unwrap();
            let completed = events
                .iter()
                .filter(|e| {
                    e["type"] == "memory.operation"
                        && e["payload"]["kind"] == "consolidation"
                        && e["payload"]["phase"] == "complete"
                })
                .count();
            if completed == count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("new consolidation completion");
    assert_eq!(calls(s), count);
}

async fn wait_calls(s: &Scenario, count: usize) {
    tokio::time::timeout(Duration::from_secs(90), async {
        while calls(s) < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("consolidation reached model");
}

#[tokio::test]
async fn time_persists_and_runs_once_at_the_selected_minute() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("MEM-CONSOLIDATION-TIME").await?;
    assert_eq!(
        s.gw.get("/settings").await?.data()["consolidation_time"],
        "04:00"
    );
    let saved =
        s.gw.patch("/settings", json!({"consolidation_time":"05:00"}))
            .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    assert_eq!(saved.data()["consolidation_time"], "05:00");
    s.restart().await?;
    assert_eq!(
        s.gw.get("/settings").await?.data()["consolidation_time"],
        "05:00"
    );
    let config: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(
        config.pointer("/cognition/consolidationCycle/timeOfDay"),
        Some(&json!("05:00"))
    );
    clock(&address, "2026-10-02T04:59:00.000Z").await?;
    settled(&address).await?;
    assert_eq!(calls(&s), 0);
    clock(&address, "2026-10-02T05:00:00.000Z").await?;
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(state(&s)["lastRunDate"], "2026-10-02");
    s.restart().await?;
    settled(&address).await?;
    assert_eq!(calls(&s), 1);
    s.finish().await
}

#[tokio::test]
async fn missed_time_runs_once_late_on_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("MEM-CONSOLIDATION-MISSED").await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"consolidation_time":"05:00"}))
            .await?
            .status,
        200
    );
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-10-02T07:00:00.000Z");
    s.gw = s.agent.start_again().await?;
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(calls(&s), 1);
    assert_eq!(state(&s)["late"], true);
    assert_eq!(state(&s)["scheduledAt"], "2026-10-02T05:00:00.000Z");
    assert_eq!(
        s.gw.get("/memory/consolidation").await?.data()["last_run"]["late"],
        true
    );
    s.restart().await?;
    settled(&address).await?;
    assert_eq!(calls(&s), 1);
    clock(&address, "2026-10-03T05:00:00.000Z").await?;
    clock(&address, "wake").await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while state(&s)["lastRunDate"] != "2026-10-03" {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("next day's scheduled run");
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(state(&s)["lastRunDate"], "2026-10-03");
    assert_eq!(calls(&s), 2);
    assert_eq!(state(&s)["late"], false);
    s.finish().await
}

#[tokio::test]
async fn manual_result_and_events_do_not_consume_the_scheduled_day() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _) = setup("MEM-CONSOLIDATION-MANUAL").await?;
    let before = state(&s)["lastRunDate"].clone();
    let id = uuid::Uuid::new_v4().to_string();
    let reply =
        s.gw.post("/memory/consolidation", json!({"operation_id":id}))
            .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_eq!(reply.data()["operation_id"], id);
    assert_eq!(
        terminal(&s, "manual", "complete").await?["operation_id"],
        id
    );
    let view = s.gw.get("/memory/consolidation").await?;
    assert_eq!(view.data()["last_run"]["status"], "ok");
    assert_eq!(view.data()["last_run"]["trigger"], "manual");
    assert!(view.data()["last_run"]["at"].is_string());
    assert_eq!(view.data()["time_of_day"], "04:00");
    assert_eq!(state(&s)["lastRunDate"], before);
    assert_eq!(calls(&s), 1);
    s.finish().await
}

#[tokio::test]
async fn run_now_returns_the_active_scheduled_receipt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("MEM-CONSOLIDATION-SINGLE").await?;
    let held = s.provider()?.hold_next_reply("general_new_chat_briefing");
    clock(&address, "2026-10-02T04:00:00.000Z").await?;
    wait_calls(&s, 1).await;
    let active = s.gw.get("/memory/consolidation").await?.data()["active"].clone();
    let reply =
        s.gw.post(
            "/memory/consolidation",
            json!({"operation_id":uuid::Uuid::new_v4()}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data(), &active);
    assert_eq!(active["trigger"], "scheduled");
    held.release();
    let done = terminal(&s, "scheduled", "complete").await?;
    assert_eq!(done["operation_id"], state(&s)["runId"]);
    assert_eq!(calls(&s), 1);
    let logs = butler_e2e::e2e::agent::read_all(&s.agent.launch.logs);
    assert_eq!(
        logs.matches("[consolidation-cycle] status=").count(),
        1,
        "one cycle in the logs"
    );
    s.finish().await
}

fn failed_profile(request: &Value) -> Option<ResponseRecord> {
    briefing(request).or_else(|| Some(butler_e2e::e2e::provider::title_response("Understood.")))
}

pub(crate) fn successful_profile(request: &Value) -> Option<ResponseRecord> {
    if super::memory_patterns::task(request)["task"] == "pattern_extraction" {
        return Some(butler_e2e::e2e::provider::title_response(
            r#"{"updates":[]}"#,
        ));
    }
    briefing(request).or_else(|| {
        Some(butler_e2e::e2e::provider::title_response(
            r#"{"candidates":[]}"#,
        ))
    })
}

#[tokio::test]
async fn failed_manual_run_does_not_prevent_tomorrows_schedule() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("MEM-CONSOLIDATION-FAILED").await?;
    s.provider()?.set_chat_responder(failed_profile);
    assert_eq!(
        s.gw.patch("/personalization", json!({"profiling":{"mode":"basic"}}))
            .await?
            .status,
        200
    );
    let (_, turn) = s
        .turn(
            "general",
            "I prefer concise answers. Please remember my preference.",
        )
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    // Wait for turn memory completion to release the writer before running consolidation.
    super::memory_fixture::settle(&s.sandbox.data).await?;
    let reply =
        s.gw.post(
            "/memory/consolidation",
            json!({"operation_id":uuid::Uuid::new_v4()}),
        )
        .await?;
    assert_eq!(reply.status, 202);
    terminal(&s, "manual", "failed").await?;
    assert_eq!(
        s.gw.get("/memory/consolidation").await?.data()["last_run"]["status"],
        "error"
    );
    s.provider()?.set_chat_responder(successful_profile);
    clock(&address, "2026-10-03T04:00:00.000Z").await?;
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(state(&s)["status"], "ok");
    assert_eq!(state(&s)["lastRunDate"], "2026-10-03");
    s.finish().await
}

#[tokio::test]
async fn consolidation_model_and_reasoning_survive_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _) = setup("MEM-CONSOLIDATION-MODEL").await?;
    let model = s.model.model.clone();
    let reply =
        s.gw.patch(
            "/settings",
            json!({"consolidation_model":model,"consolidation_reasoning_effort":"low"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    s.restart().await?;
    let settings = s.gw.get("/settings").await?;
    assert_eq!(settings.data()["consolidation_model"], model);
    assert_eq!(settings.data()["consolidation_reasoning_effort"], "low");
    let config: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(
        config.pointer("/personalization/profiling/extractorModel"),
        Some(&json!(model))
    );
    s.finish().await
}
