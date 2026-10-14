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
    let setup = Setup::new(id)?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_APP_NOW", "2026-10-13T21:55:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
        .env("BUTLER_E2E_SCHEDULER_INSTRUMENTATION", "1");
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    Ok((s, address))
}

async fn clock_control(address: String, value: String) -> Result<Value, HarnessError> {
    tokio::task::spawn_blocking(move || -> Result<Value, HarnessError> {
        let mut stream = TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        writeln!(stream, "{value}")?;
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply)?;
        Ok(serde_json::from_str(&reply)?)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}

async fn jump(address: String, now: &'static str) -> Result<(), HarnessError> {
    assert_eq!(clock_control(address, now.into()).await?["now"], now);
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
    // Two checks mean the initial tick completed and its wall-clock wait began.
    while clock_control(address.clone(), String::new()).await?["context_reads"]
        .as_u64()
        .unwrap()
        < 2
    {
        assert!(
            Instant::now() < deadline,
            "daily jobs did not enter their wait"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Jump halfway through the established slice, leaving time for dispatch
    // and API observation inside the unchanged one-slice timeout.
    tokio::time::sleep(butler_core::wall_clock::MAX_WAIT_SLICE / 2).await;
    jump(address.clone(), "2026-10-16T22:04:22.000Z").await?;
    let expected_ms = chrono::DateTime::parse_from_rfc3339("2026-10-16T22:04:22.000Z")
        .unwrap()
        .timestamp_millis();
    let start = Instant::now();
    let observed_ms = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let state = clock_control(address.clone(), String::new()).await?;
            if !runs(&s).await?.is_empty() && state["context_now_ms"] == expected_ms {
                return Ok::<_, HarnessError>(start.elapsed().as_millis());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| {
        HarnessError("wall-clock deadlines were not rechecked within the wait slice".into())
    })??;
    let records = runs(&s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["trigger"], "scheduled");
    assert_eq!(
        clock_control(address, String::new()).await?["context_now_ms"],
        expected_ms
    );
    assert_next(&s, "2026-10-17T22:00:00.000Z").await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs(&s).await?.len(), 1);
    eprintln!("SCHED-07 simulated suspend wake_ms={observed_ms}");
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

#[tokio::test]
async fn sched_11_interval_anchor_uses_store_timestamp_precision() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-11").await?;
    let reply =
        s.gw.post(
            "/automations",
            json!({"id":"anchored", "title":"Daily",
        "target_session_id":"general", "prompt_body":NUMBERS,
        "schedule_type":"interval", "interval_seconds":86400,
        "start_at":"2026-10-13T22:00:00.000123456Z"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    tokio::time::sleep(Duration::from_millis(200)).await;
    jump(address, "2026-10-16T22:00:00.000Z").await?;
    let reply = s.gw.post("/automations/anchored/run", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_next(&s, "2026-10-17T22:00:00.000Z").await?;
    s.finish().await
}
