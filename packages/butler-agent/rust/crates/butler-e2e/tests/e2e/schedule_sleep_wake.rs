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

mod diagnostics;
use diagnostics::*;

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

async fn setup(id: &str) -> Result<(Scenario, String), HarnessError> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut setup = Setup::new(id)?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_APP_NOW", "2026-10-13T21:55:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
        .env("BUTLER_E2E_SCHEDULER_INSTRUMENTATION", "1");
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    if id == "SCHED-07" {
        let mut cassette = butler_e2e::e2e::cassette::Cassette::load("TURN-01")?;
        super::memory_stubs::daily_briefing(&mut cassette, &setup.sandbox.data)?;
        let model = cassette.exchanges[0].request.key.model.clone();
        cassette.exchanges.last_mut().unwrap().request.key.model = model;
        setup = setup.stub_cassette(cassette);
    }
    let s = setup.start().await?;
    // These clock-jump scenarios exercise delivery at 22:04, outside quiet hours.
    let settings =
        s.gw.patch("/settings", json!({"quiet_hours_start":"23:00"}))
            .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
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
    let started = Instant::now();
    let deadline = started + Duration::from_secs(10);
    loop {
        let records = runs(s).await?;
        let reply = s.gw.get("/automations").await?;
        let row = &reply.data()["automations"][0];
        if let Some(run) = records.first()
            && matches!(
                run["state"].as_str(),
                Some("succeeded" | "failed" | "skipped_target_unavailable")
            )
        {
            assert_eq!(run["state"], "succeeded", "{run}");
            assert!(row["run_count"].as_u64().unwrap_or(0) > 0, "{row}");
            assert_eq!(row["next_run_at"], expected, "{row}");
            eprintln!(
                "schedule terminal poll_ms={}",
                started.elapsed().as_millis()
            );
            break;
        }
        if Instant::now() >= deadline {
            eprintln!("run did not complete: {row}; runs={:?}", runs(s).await?);
            scheduler_diagnostics(s).await?;
            maintenance_logs(s).await?;
            panic!("run did not complete within 10 seconds");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

async fn maintenance_logs(s: &Scenario) -> Result<(), HarnessError> {
    let directory = s.sandbox.logs.clone();
    let logs = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        let mut logs = String::new();
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            if entry.path().is_file() {
                for line in std::fs::read_to_string(entry.path())?.lines() {
                    if line.contains("[session-sync]") || line.contains("[consolidation-cycle]") {
                        logs.push_str(line);
                        logs.push('\n');
                    }
                }
            }
        }
        Ok(logs)
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))??;
    eprintln!("maintenance log timestamps:\n{logs}");
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
    eprintln!(
        "SCHED-07 simulated suspend wake_ms={observed_ms} observed_state={}",
        records[0]["state"]
    );
    maintenance_logs(&s).await?;
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

async fn create_implicit(s: &Scenario) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(
            "/automations",
            json!({
                "id":"anchored", "title":"Daily", "target_session_id":"general",
                "prompt_body":NUMBERS, "schedule_type":"interval", "interval_seconds":86400
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let row = s.gw.get("/automations").await?.data()["automations"][0].clone();
    assert!(row["start_at"].is_null(), "{row}");
    assert_eq!(row["next_run_at"], "2026-10-14T21:55:00.000Z");
    Ok(())
}

#[tokio::test]
async fn sched_12_run_now_preserves_implicit_anchor() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-12").await?;
    create_implicit(&s).await?;
    jump(address, "2026-10-13T21:55:09.000Z").await?;
    let reply = s.gw.post("/automations/anchored/run", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_next(&s, "2026-10-14T21:55:00.000Z").await?;
    let records = runs(&s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["trigger"], "run_now");
    s.finish().await
}

#[tokio::test]
async fn sched_13_late_run_preserves_implicit_grid() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-13").await?;
    create_implicit(&s).await?;
    jump(address, "2026-10-16T22:04:22.000Z").await?;
    let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_next(&s, "2026-10-17T21:55:00.000Z").await?;
    let records = runs(&s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["trigger"], "scheduled");
    s.finish().await
}

async fn dispatch_fault(data: &std::path::Path, install: bool) -> Result<(), HarnessError> {
    let path = data.join("app-server/butler-client.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = butler_platform::sqlite::open(path)?;
        db.execute_batch(if install {
            "CREATE TRIGGER fail_schedule_run BEFORE INSERT ON app_automation_runs
             BEGIN SELECT RAISE(ABORT, 'schedule-dispatch-fault'); END;"
        } else {
            "DROP TRIGGER fail_schedule_run"
        })?;
        Ok(())
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))?
}

async fn error_event_fault(data: &std::path::Path, install: bool) -> Result<(), HarnessError> {
    let path = data.join("app-server/butler-client.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = butler_platform::sqlite::open(path)?;
        db.execute_batch(if install {
            "CREATE TRIGGER fail_scheduler_event BEFORE INSERT ON events
             WHEN NEW.type='automation.scheduler_error'
             BEGIN SELECT RAISE(ABORT, 'scheduler-event-fault'); END;"
        } else {
            "DROP TRIGGER fail_scheduler_event"
        })?;
        Ok(())
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))?
}

async fn scheduler_errors(data: &std::path::Path) -> Result<usize, HarnessError> {
    let path = data.join("app-server/butler-client.sqlite");
    tokio::task::spawn_blocking(move || -> Result<usize, HarnessError> {
        let db = butler_platform::sqlite::open(path)?;
        Ok(db.query_row(
            "SELECT COUNT(*) FROM events WHERE type='automation.scheduler_error'",
            [],
            |row| row.get(0),
        )?)
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))?
}

async fn wake_scheduler(s: &Scenario) -> Result<(), HarnessError> {
    let reply =
        s.gw.patch("/automations/anchored", json!({"title":"Daily"}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(())
}

#[tokio::test]
async fn sched_14_failed_dispatch_retries_without_notification() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SCHED-14").await?;
    create(&s).await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if scheduler_reads(&s).await? >= 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "scheduler did not read the schedule"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    dispatch_fault(&s.sandbox.data, true).await?;
    error_event_fault(&s.sandbox.data, true).await?;
    jump(address.clone(), "2026-10-13T22:00:00.000Z").await?;
    let before = scheduler_reads(&s).await?;
    wake_scheduler(&s).await?;
    wait_scheduler_reads(&s, before + 1).await?;
    assert_eq!(scheduler_errors(&s.sandbox.data).await?, 0);
    assert_eq!(runs(&s).await?, [] as [Value; 0]);
    error_event_fault(&s.sandbox.data, false).await?;
    wake_scheduler(&s).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while scheduler_errors(&s.sandbox.data).await? == 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, HarnessError>(Instant::now())
    })
    .await
    .map_err(|_| HarnessError("scheduler did not observe the dispatch failure".into()))??;
    assert_eq!(scheduler_errors(&s.sandbox.data).await?, 1);
    // A notified retry during the same failure streak must not emit another error.
    let reads_before = scheduler_reads(&s).await?;
    let last = scheduler_attempts(&s).await?;
    wake_scheduler(&s).await?;
    let dispatch_observed = wait_scheduler_attempt(&s, last, reads_before).await?;
    assert_eq!(scheduler_errors(&s.sandbox.data).await?, 1);
    assert_eq!(runs(&s).await?, [] as [Value; 0]);
    dispatch_fault(&s.sandbox.data, false).await?;
    // No wake: the natural retry must dispatch and finish within one slice plus jitter.
    let deadline =
        dispatch_observed + butler_core::wall_clock::MAX_WAIT_SLICE + Duration::from_secs(5);
    let started = Instant::now();
    let recovery = tokio::time::timeout_at(deadline.into(), async {
        while !runs(&s)
            .await?
            .iter()
            .any(|run| run["state"] == "succeeded")
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .map_err(|_| HarnessError("scheduler did not recover without notification".into()))
    .and_then(|result| result);
    if recovery.is_err() {
        eprintln!(
            "SCHED-14 diagnostics: {:?}",
            scheduler_diagnostics(&s).await
        );
        let probe =
            s.gw.patch("/automations/anchored", json!({"title":"Writer probe"}))
                .await;
        eprintln!("SCHED-14 writer probe: {probe:?}");
    }
    recovery?;
    eprintln!(
        "SCHED-14 unnotified_retry_ms={}",
        started.elapsed().as_millis()
    );
    assert_next(&s, "2026-10-14T22:00:00.000Z").await?;
    assert_eq!(runs(&s).await?.len(), 1);
    assert_eq!(scheduler_errors(&s.sandbox.data).await?, 1);
    dispatch_fault(&s.sandbox.data, true).await?;
    jump(address, "2026-10-14T22:00:00.000Z").await?;
    wake_scheduler(&s).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while scheduler_errors(&s.sandbox.data).await? < 2 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .map_err(|_| HarnessError("successful dispatch did not clear the error streak".into()))??;
    assert_eq!(scheduler_errors(&s.sandbox.data).await?, 2);
    assert_eq!(runs(&s).await?.len(), 1);
    eprintln!("SCHED-14 persistent retries=1 streak_errors=1 after_success_errors=2");
    s.finish().await
}
