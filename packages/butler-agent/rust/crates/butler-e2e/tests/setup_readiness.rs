//! First-run setup (#230): the agent's own preparation, `GET
//! /setup/readiness`, `POST /setup/readiness/retry` and the live event
//! `setup.readiness_changed`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::{Fixture, Setup};
use serde_json::Value;

const STEPS: [&str; 3] = ["data_folder", "model_config", "agent_runtime"];

/// Polls `GET /setup/readiness` until its status is `status`.
async fn readiness_until(gw: &Gateway, status: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let reply = gw.get("/setup/readiness").await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        if reply.data()["status"] == status || Instant::now() > deadline {
            return Ok(reply.data().clone());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn step_ids(view: &Value) -> Vec<&str> {
    view["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|step| step["id"].as_str())
        .collect()
}

/// SETUP-01 — A fresh install prepares in the background and reports
/// every step done, in order, once it is ready.
#[tokio::test]
async fn setup_01_fresh_install_reports_ready_with_its_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SETUP-01")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    let view = readiness_until(&s.gw, "ready").await?;
    assert_eq!(view["status"], "ready", "{view}");
    assert_eq!(step_ids(&view), STEPS, "{view}");
    for step in view["steps"].as_array().unwrap() {
        assert_eq!(step["status"], "done", "{view}");
        assert!(step.get("error").is_none(), "{view}");
    }
    assert!(
        !s.sandbox.data.join("state/setup-readiness.probe").exists(),
        "the probe file was left behind"
    );
    s.finish().await
}

/// SETUP-02 — A step that fails stops the preparation with a stable reason;
/// the later steps stay pending. After the cause is gone, a retry prepares
/// again and the live event `setup.readiness_changed` carries the new view.
#[tokio::test]
async fn setup_02_failed_step_reports_its_reason_and_retry_recovers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("SETUP-02")?.fixture(Fixture::Empty);
    // A directory where the probe file goes: the data folder takes no write there.
    let probe = setup.sandbox.data.join("state/setup-readiness.probe");
    std::fs::create_dir_all(probe.join("blocked"))?;
    let s = setup.start().await?;

    let failed = readiness_until(&s.gw, "failed").await?;
    assert_eq!(failed["status"], "failed", "{failed}");
    let steps = failed["steps"].as_array().unwrap();
    assert_eq!(steps[0]["id"], "data_folder", "{failed}");
    assert_eq!(steps[0]["status"], "failed", "{failed}");
    assert_eq!(
        steps[0]["error"]["code"], "data_folder_unwritable",
        "{failed}"
    );
    let detail = steps[0]["error"]["detail"].as_str().unwrap_or_default();
    assert!(!detail.is_empty(), "{failed}");
    assert!(
        !detail.contains(&s.sandbox.data.display().to_string()),
        "the reason names a private path: {detail}"
    );
    assert!(
        steps[1..].iter().all(|step| step["status"] == "pending"),
        "{failed}"
    );

    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    std::fs::remove_dir_all(&probe)?;
    let retry =
        s.gw.post("/setup/readiness/retry", serde_json::json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    assert_eq!(retry.data()["status"], "preparing", "{}", retry.text);
    let event = live
        .wait_for(Duration::from_secs(30), |event| {
            event["type"] == "setup.readiness_changed" && event["payload"]["status"] == "ready"
        })
        .await?;
    assert_eq!(step_ids(&event["payload"]), STEPS, "{event}");
    assert_eq!(
        s.gw.get("/setup/readiness").await?.data()["status"],
        "ready"
    );

    // A retry of a finished preparation runs it again.
    let again =
        s.gw.post("/setup/readiness/retry", serde_json::json!({}))
            .await?;
    assert_eq!(again.status, 202, "{}", again.text);
    assert_eq!(readiness_until(&s.gw, "ready").await?["status"], "ready");
    s.finish().await
}
