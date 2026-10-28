//! Requests wait only for accepted records, and only for a bounded interval.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn stalled_writer_bounds_request_and_reports_timeout() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-WRITE-TIMEOUT")?.start().await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    assert_eq!(
        s.gw.get("/internal/e2e/logs/writer/pause").await?.status,
        200
    );
    let start = Instant::now();
    let response = tokio::time::timeout(
        Duration::from_millis(750),
        s.gw.patch("/settings", json!({"reduce_motion":true})),
    )
    .await
    .unwrap()?;
    let elapsed = start.elapsed();
    assert_eq!(response.status, 200);
    assert!(elapsed >= Duration::from_millis(250));
    let status = s.gw.get("/internal/e2e/logs/writer/status").await?;
    assert_eq!(status.data()["write_timeouts"], 1);
    assert_eq!(
        s.gw.get("/internal/e2e/logs/writer/resume").await?.status,
        200
    );
    assert_eq!(s.gw.get("/logs/storage").await?.data()["write_timeouts"], 1);
    eprintln!(
        "LOG-WRITE-TIMEOUT request_ms={:.3} timeouts=1",
        elapsed.as_secs_f64() * 1000.0
    );
    s.finish().await
}

#[tokio::test]
async fn full_queue_request_returns_without_waiting() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-WRITE-DROP")?.start().await?;
    assert_eq!(
        s.gw.get("/internal/e2e/logs/writer/pause").await?.status,
        200
    );
    let full = s.gw.get("/internal/e2e/logs/writer/fill").await?;
    assert_eq!(full.status, 200);
    let dropped = full.data()["dropped_info"].as_u64().unwrap();
    let start = Instant::now();
    let response =
        s.gw.patch("/settings", json!({"reduce_motion":true}))
            .await?;
    assert_eq!(response.status, 200);
    let elapsed = start.elapsed();
    let status = s.gw.get("/internal/e2e/logs/writer/status").await?;
    // These counters prove the request did not wait; wall time depends on host load.
    assert!(status.data()["dropped_info"].as_u64().unwrap() > dropped);
    assert_eq!(status.data()["write_timeouts"], 0);
    assert_eq!(
        s.gw.get("/internal/e2e/logs/writer/resume").await?.status,
        200
    );
    assert_eq!(s.gw.get("/settings").await?.data()["reduce_motion"], true);
    eprintln!(
        "LOG-WRITE-DROP request_ms={:.3} timeouts=0",
        elapsed.as_secs_f64() * 1000.0
    );
    s.finish().await
}
