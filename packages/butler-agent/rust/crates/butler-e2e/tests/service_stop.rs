//! SVC-09 — the control endpoint's `service_stop` (how a stop reaches an
//! instance on hosts without stop signals; SIGTERM elsewhere) obeys the
//! same rule as SIGTERM: only a stop the controller announced in the DATA
//! stop intent, and only with the instance's control token.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::stop_intent::{control_command, instance_record, intent_path};
use serde_json::json;

#[tokio::test]
async fn svc_09_service_stop_needs_the_token_and_the_announcement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-09")?.start().await?;
    let data = s.sandbox.data.clone();
    let deadline = Instant::now() + Duration::from_secs(30);
    let record = loop {
        if let Some(record) = instance_record(&data).filter(|record| record["state"] == "ready") {
            break record;
        }
        assert!(Instant::now() < deadline, "no ready instance record");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    let wrong = control_command(&record, "service_stop", Some("not-the-token"))?;
    assert_ne!(wrong["result"]["ok"], true, "{wrong}");
    let unannounced = control_command(&record, "service_stop", None)?;
    assert_eq!(
        unannounced["result"]["error"]["code"], "service_stop_unannounced",
        "{unannounced}"
    );
    assert!(s.gw.healthy().await, "a refused stop stopped the service");

    std::fs::write(
        intent_path(&data),
        json!({
            "schema": "butler.agent-stop-intent.v1", "reason": "stop", "requested_by": "cli",
            "respawn_by": null, "instance_id": record["nonce"], "pid": record["pid"],
            "requested_at": "2026-09-29T00:00:00.000Z",
        })
        .to_string(),
    )?;
    let accepted = control_command(&record, "service_stop", None)?;
    assert_eq!(accepted["result"]["ok"], true, "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "the announced stop did not stop");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let status = s.agent.reap().expect("the stopped agent is collected");
    assert!(status.success(), "a requested stop must exit 0: {status}");
    s.finish().await
}
