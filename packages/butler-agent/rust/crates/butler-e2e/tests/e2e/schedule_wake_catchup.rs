//! SS12: OS wake, rather than the existing clock slice, dispatches catch-up.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn clock(address: &str, line: &str) -> Result<Value, HarnessError> {
    let mut stream = tokio::net::TcpStream::connect(address).await?;
    stream.write_all(format!("{line}\n").as_bytes()).await?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).await?;
    Ok(serde_json::from_str(&reply)?)
}
async fn runs(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    Ok(
        s.gw.get("/automations/wake-daily/runs").await?.data()["runs"]
            .as_array()
            .unwrap()
            .clone(),
    )
}
#[tokio::test]
async fn ss12_automation_wake_catches_up_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut cassette = Cassette::load("TURN-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new("SS12-AUTOMATION")?
        .stub_cassette(cassette)
        .env("TZ", "UTC")
        .env("BUTLER_E2E_APP_NOW", "2026-10-13T21:55:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
        .env("BUTLER_E2E_SCHEDULER_INSTRUMENTATION", "1");
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    // Wake catch-up at 22:04 is outside this scenario's quiet-hours window.
    let settings =
        s.gw.patch("/settings", json!({"quiet_hours_start":"23:00"}))
            .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    s.provider()?.set_chat_responder(|_| {
        Some(butler_e2e::e2e::provider::title_response(
            "This run ran late.",
        ))
    });
    let reply =
        s.gw.post(
            "/automations",
            json!({"id":"wake-daily", "title":"Daily",
        "target_session_id":"general", "prompt_body":"Summarize recent activity.",
        "schedule_type":"interval", "interval_seconds":86400,
        "start_at":"2026-10-13T22:00:00.000Z"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if s.gw
                .get("/automations/_test/scheduler-next-due-reads")
                .await?
                .data()
                .as_u64()
                .unwrap_or(0)
                >= 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("scheduler entered its wait")?;
    // Let the indexed read complete and the notified wait arm become pending.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(runs(&s).await?, [] as [Value; 0]);
    clock(&address, "2026-10-16T22:04:22.000Z").await?;
    let started = Instant::now();
    clock(&address, "wake").await?;
    // The next-due probe establishes a fresh 60 s wait. Five seconds is well
    // inside its remaining slice, so this can pass only through the wake signal.
    let records = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let records = runs(&s).await?;
            if records.iter().any(|run| run["state"] == "succeeded") {
                return Ok::<_, HarnessError>(records);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("wake dispatch within 5 seconds")?;
    eprintln!(
        "SS12 automation wake_to_dispatch_ms={}",
        started.elapsed().as_millis()
    );
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["trigger"], "scheduled");
    assert_eq!(records[0]["late"], true);
    assert_eq!(records[0]["scheduled_at"], "2026-10-16T22:00:00.000Z");
    let turn =
        s.gw.wait_turn(
            "general",
            records[0]["turn_id"].as_str().unwrap(),
            butler_e2e::e2e::gateway::TERMINAL,
            Duration::from_secs(90),
        )
        .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&turn),
        "delivered",
        "{turn}"
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("This scheduled run was due at")
                && r.to_string().contains("Cover the whole period up to now"))
    );
    let row = s.gw.get("/automations").await?.data()["automations"][0].clone();
    assert_eq!(row["next_run_at"], "2026-10-17T22:00:00.000Z");
    let events = s.gw.events_since(0).await?;
    assert!(events.iter().any(|e| e["type"] == "automation.run"
        && e["payload"]["late"] == true
        && e["payload"]["scheduled_at"] == records[0]["scheduled_at"]));
    clock(&address, "wake").await?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(runs(&s).await?.len(), 1);
    s.agent.terminate().await?;
    s.finish().await
}
