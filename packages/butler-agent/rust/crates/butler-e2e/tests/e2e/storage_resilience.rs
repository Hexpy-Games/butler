//! Public schedule requests survive lane/owner faults and classify contention.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use std::time::{Duration, Instant};

use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Scenario, Setup, turn_timeout},
};
use serde_json::json;

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

async fn create(s: &Scenario) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/automations",
            json!({
                "title": "Numbers", "prompt_body": NUMBERS,
                "target_session_id": "general", "interval_seconds": 3600,
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

async fn verify_recovered(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let due = s.gw.post("/automations/dispatch-due", json!({})).await?;
    eprintln!("following dispatch-due: {} {}", due.status, due.text);
    let list = s.gw.get("/automations").await?;
    eprintln!("following list: {} {}", list.status, list.text);
    assert_eq!(due.status, 202, "{}", due.text);
    assert_eq!(due.data()["runs"], json!([]));
    assert_eq!(list.status, 200, "{}", list.text);
    let rows = list.data()["automations"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id);
    assert_eq!(
        rows[0]["title"], "Numbers",
        "panic left an uncommitted write"
    );
    assert_eq!(rows[0]["run_count"], 0);
    let run =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn_id = run.data()["run"]["turn_id"].as_str().unwrap();
    let turn =
        s.gw.wait_terminal("general", turn_id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let runs = s.gw.get(&format!("/automations/{id}/runs")).await?;
    assert_eq!(runs.status, 200, "{}", runs.text);
    assert_eq!(runs.data()["runs"].as_array().unwrap().len(), 1);
    assert_eq!(runs.data()["runs"][0]["turn_id"], turn_id);
    Ok(())
}

#[cfg(debug_assertions)]
async fn panic_recovery(fault: &str, sentinel: &str) -> Result<(), HarnessError> {
    let s = Setup::new(&format!("STORAGE-PANIC-{fault}"))?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_DISPATCH_FAULT", fault)
        .start()
        .await?;
    let id = create(&s).await?;
    let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
    eprintln!("panicking dispatch-due: {} {}", reply.status, reply.text);
    assert_eq!(reply.status, 500, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("internal_error"));
    assert!(!reply.text.contains(sentinel));
    let logs = s.agent.logs();
    assert!(logs.contains(sentinel), "{logs}");
    assert!(
        logs.contains("panicked at"),
        "panic location missing: {logs}"
    );
    verify_recovered(&s, &id).await?;
    s.finish().await
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn storage_lane_panic_fails_only_one_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    panic_recovery("lane", "e2e-app-lane-panic-sentinel").await
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn automation_owner_panic_fails_only_one_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    panic_recovery("owner", "e2e-automation-owner-panic-sentinel").await
}

#[tokio::test]
async fn schedule_write_contention_is_retryable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("STORAGE-BUSY")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let id = create(&s).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .expect("open isolated App database");
    db.busy_timeout(Duration::ZERO)
        .expect("lock without waiting");
    db.execute_batch("BEGIN IMMEDIATE")
        .expect("hold App write lock");
    let held = Instant::now();
    let reply =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    eprintln!(
        "write lock held {:?}: {} {}",
        held.elapsed(),
        reply.status,
        reply.text
    );
    assert!(held.elapsed() >= Duration::from_secs(5));
    assert_eq!(reply.status, 503, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("storage_busy"));
    assert!(!reply.text.contains("app_sqlite"));
    db.execute_batch("ROLLBACK")
        .expect("release App write lock");
    drop(db);
    verify_recovered(&s, &id).await?;
    s.finish().await
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn closing_storage_reports_service_stopping() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("STORAGE-CLOSING")?
        .env("BUTLER_E2E_DISPATCH_FAULT", "closing")
        .start()
        .await?;
    let _id = create(&s).await?;
    for _ in 0..2 {
        let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
        assert_eq!(reply.status, 503, "{}", reply.text);
        assert_eq!(reply.error_code(), Some("service_stopping"));
        assert!(!reply.text.contains("app_sqlite"));
    }
    s.finish().await
}
