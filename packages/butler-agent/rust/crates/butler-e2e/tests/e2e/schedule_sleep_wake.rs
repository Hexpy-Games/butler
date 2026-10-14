//! Wall-clock jumps must not wait for equivalent awake time or shift anchors.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant},
};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

async fn setup(id: &str) -> Result<(Scenario, String), HarnessError> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let s = Setup::new(id)?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_APP_NOW", "2026-10-13T21:55:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
        .env("BUTLER_E2E_SCHEDULER_INSTRUMENTATION", "1")
        .start()
        .await?;
    Ok((s, address))
}

async fn jump(address: String, now: &'static str) -> Result<(), HarnessError> {
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut stream = TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        writeln!(stream, "{now}")?;
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply)?;
        assert_eq!(reply, "ok\n");
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    Ok(())
}

async fn create(s: &Scenario) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(
            "/automations",
            json!({"id":"anchored", "title":"Daily",
        "target_session_id":"general", "prompt_body":NUMBERS,
        "schedule_type":"interval", "interval_seconds":86400,
        "start_at":"2026-10-13T22:00:00.000Z"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(())
}

async fn runs(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    Ok(s.gw.get("/automations/anchored/runs").await?.data()["runs"]
        .as_array()
        .unwrap()
        .clone())
}

async fn assert_next(s: &Scenario, expected: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let reply = s.gw.get("/automations").await?;
        let row = &reply.data()["automations"][0];
        if row["run_count"].as_u64().unwrap_or(0) > 0 {
            assert_eq!(row["next_run_at"], expected, "{row}");
            break;
        }
        assert!(Instant::now() < deadline, "run did not complete: {row}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

#[tokio::test]
async fn sched_07_suspend_dispatches_once_and_restores_grid() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-07").await?;
    create(&s).await?;
    // Wait for the scheduler's due read, ensuring its wait began before the jump.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let reply =
            s.gw.get("/automations/_test/scheduler-next-due-reads")
                .await?;
        if reply.data().as_u64().unwrap_or(0) >= 2 {
            break;
        }
        assert!(Instant::now() < deadline, "{}", reply.text);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(runs(&s).await?, [] as [Value; 0]);
    // Daily jobs must also have settled into their wait before suspending.
    while !s
        .sandbox
        .data
        .join("state/scheduler/consolidation-cycle.json")
        .exists()
    {
        assert!(Instant::now() < deadline, "daily jobs did not settle");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    jump(address, "2026-10-16T22:04:22.000Z").await?;
    let start = Instant::now();
    let marker = s
        .sandbox
        .data
        .join("state/scheduler/context-maintenance.json");
    while start.elapsed() < Duration::from_secs(60) {
        let maintenance: Value = serde_json::from_slice(&tokio::fs::read(&marker).await?)?;
        if !runs(&s).await?.is_empty() && maintenance["lastRunAt"] == "2026-10-16T22:04:22.000Z" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let records = runs(&s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["trigger"], "scheduled");
    let maintenance: Value = serde_json::from_slice(&std::fs::read(marker)?)?;
    assert_eq!(
        maintenance["lastRunAt"], "2026-10-16T22:04:22.000Z",
        "{maintenance}"
    );
    assert_next(&s, "2026-10-17T22:00:00.000Z").await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs(&s).await?.len(), 1);
    eprintln!(
        "SCHED-07 simulated suspend dispatch_ms={}",
        start.elapsed().as_millis()
    );
    s.finish().await
}

#[tokio::test]
async fn sched_08_run_now_preserves_future_anchor() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-08").await?;
    create(&s).await?;
    jump(address, "2026-10-13T21:55:09.000Z").await?;
    let reply = s.gw.post("/automations/anchored/run", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_next(&s, "2026-10-13T22:00:00.000Z").await?;
    assert_eq!(runs(&s).await?.len(), 1);
    s.finish().await
}

#[tokio::test]
async fn sched_09_late_run_skips_missed_grid_points() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-09").await?;
    create(&s).await?;
    jump(address, "2026-10-16T22:04:22.000Z").await?;
    let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_next(&s, "2026-10-17T22:00:00.000Z").await?;
    assert_eq!(runs(&s).await?.len(), 1);
    s.finish().await
}

#[tokio::test]
async fn sched_10_late_run_now_skips_missed_grid_points() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-10").await?;
    create(&s).await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let reply =
            s.gw.get("/automations/_test/scheduler-next-due-reads")
                .await?;
        if reply.data().as_u64().unwrap_or(0) >= 2 {
            break;
        }
        assert!(Instant::now() < deadline, "{}", reply.text);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    jump(address, "2026-10-16T22:04:22.000Z").await?;
    let reply = s.gw.post("/automations/anchored/run", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_next(&s, "2026-10-17T22:00:00.000Z").await?;
    let records = runs(&s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["trigger"], "run_now");
    s.finish().await
}
