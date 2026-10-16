//! Retired App SQLite owners resume concurrent work and preserve committed data.
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
use butler_platform::sqlite;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn idle_storage_resumes_complete_concurrent_writes_and_reads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("STORAGE-IDLE")?
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .start()
        .await?;
    let mut expected = Vec::new();
    for round in 0..2 {
        let before = counters(&s).await?;
        s.gw.get("/automations").await?;
        wait_retired(&s, &before).await?;
        let started = Instant::now();
        let replies = futures_util::future::join_all((0..8).map(|index| {
            let gateway = &s.gw;
            async move {
                gateway
                    .post(
                        "/automations",
                        json!({
                            "title": format!("Scheduled {round}-{index}"),
                            "prompt_body": format!("Complete request {round}-{index}"),
                            "target_session_id": "general",
                            "schedule_type": "interval",
                            "interval_seconds": 86400,
                            "start_at": "9999-12-30T07:00:00.000Z"
                        }),
                    )
                    .await
            }
        }))
        .await;
        for reply in replies {
            let reply = reply?;
            assert_eq!(reply.status, 201, "{}", reply.text);
            expected.push(reply.data()["automation"].clone());
        }
        eprintln!(
            "STORAGE-IDLE round={round} first_batch_us={}",
            started.elapsed().as_micros()
        );
        assert_complete(&s, &expected).await?;
    }
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_complete(&s, &expected).await?;
    s.finish().await
}

async fn assert_complete(s: &Scenario, expected: &[Value]) -> Result<(), HarnessError> {
    let reply = s.gw.get("/automations").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let rows = reply.data()["automations"].as_array().unwrap();
    assert_eq!(rows.len(), expected.len());
    for saved in expected {
        let row = rows.iter().find(|row| row["id"] == saved["id"]).unwrap();
        for field in ["title", "target_session_id", "next_run_at"] {
            assert_eq!(row[field], saved[field], "{field}: {row}");
        }
        assert_eq!(row["run_count"], 0);
        let id = saved["id"].as_str().unwrap();
        let detail = s.gw.get(&format!("/automations/{id}")).await?;
        assert_eq!(detail.status, 200, "{}", detail.text);
        assert_eq!(&detail.data()["automation"], saved);
    }
    Ok(())
}

async fn counters(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(s.gw.get("/health").await?.data()["storage"].clone())
}

async fn wait_retired(s: &Scenario, before: &Value) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let now = counters(s).await?;
        if now["writer_retirements"].as_u64().unwrap()
            > before["writer_retirements"].as_u64().unwrap()
            && now["reader_retirements"].as_u64().unwrap()
                > before["reader_retirements"].as_u64().unwrap()
        {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "storage did not retire: {before} -> {now}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn schedule(title: &str) -> Value {
    json!({"title":title,"prompt_body":"Complete request","target_session_id":"general",
        "schedule_type":"interval","interval_seconds":86400,"start_at":"9999-12-30T07:00:00.000Z"})
}

#[tokio::test]
async fn idle_storage_accepts_a_request_during_retirement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("STORAGE-IDLE-RACE")?;
    let release = setup.sandbox.root.join("retire-release");
    let s = setup
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .env("BUTLER_E2E_HOLD_POINT", "app_sqlite_retire")
        .env(
            "BUTLER_E2E_HOLD_RELEASE",
            release.to_string_lossy().into_owned(),
        )
        .start()
        .await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !release.with_extension("held").exists() {
        assert!(Instant::now() < deadline, "writer never entered retirement");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let before = counters(&s).await?;
    let gateway = s.gw.clone();
    let request = gateway.post("/automations", schedule("During retirement"));
    tokio::pin!(request);
    loop {
        tokio::select! {
            reply = &mut request => panic!("request completed before retirement released: {:?}", reply?.status),
            now = counters(&s) => {
                if now?["writer_admissions"].as_u64().unwrap() > before["writer_admissions"].as_u64().unwrap() { break; }
            }
        }
        assert!(
            Instant::now() < deadline,
            "request never admitted during retirement"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    std::fs::write(&release, b"release")?;
    let reply = request.await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    assert!(
        counters(&s).await?["writer_retirements"].as_u64().unwrap()
            > before["writer_retirements"].as_u64().unwrap()
    );
    assert_complete(&s, &[reply.data()["automation"].clone()]).await?;
    s.finish().await
}

#[tokio::test]
async fn idle_storage_retries_after_an_injected_open_failure() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("STORAGE-IDLE-OPEN-FAILURE")?;
    let armed = setup.sandbox.root.join("fault");
    let marker = armed.join("used");
    let release = setup.sandbox.root.join("retire-release");
    let s = setup
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .env("BUTLER_E2E_HOLD_POINT", "app_sqlite_retire")
        .env(
            "BUTLER_E2E_HOLD_RELEASE",
            release.to_string_lossy().into_owned(),
        )
        .env("BUTLER_E2E_FILE_FAULT", "app_sqlite_open")
        .env(
            "BUTLER_E2E_FILE_FAULT_MARKER",
            marker.to_string_lossy().into_owned(),
        )
        .start()
        .await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !release.with_extension("held").exists() {
        assert!(Instant::now() < deadline, "writer never entered retirement");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    std::fs::create_dir(&armed)?;
    let before = counters(&s).await?["writer_admissions"].as_u64().unwrap();
    let gateway = s.gw.clone();
    let requests = futures_util::future::join_all(
        (0..8).map(|_| gateway.post("/automations", schedule("Failed open"))),
    );
    tokio::pin!(requests);
    loop {
        tokio::select! {
            _ = &mut requests => panic!("queued requests completed before retirement released"),
            now = counters(&s) => {
                if now?["writer_admissions"].as_u64().unwrap() >= before + 8 { break; }
            }
        }
        assert!(Instant::now() < deadline, "eight requests never admitted");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    std::fs::write(&release, b"release")?;
    for failed in requests.await {
        let failed = failed?;
        assert_eq!(failed.status, 500, "{}", failed.text);
    }
    assert!(marker.exists(), "open fault was not injected");
    let reply =
        s.gw.post("/automations", schedule("Recovered open"))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    assert_complete(&s, &[reply.data()["automation"].clone()]).await?;
    s.finish().await
}

#[tokio::test]
async fn idle_storage_preserves_backfill_across_retirement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("STORAGE-IDLE-WAL")?
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .start()
        .await?;
    let before = counters(&s).await?;
    s.gw.get("/automations").await?;
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let db = sqlite::open(&path)?;
    db.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    db.execute_batch(
        "PRAGMA wal_autocheckpoint=0; CREATE TABLE retirement_probe(value BLOB);
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2500)
        INSERT INTO retirement_probe SELECT zeroblob(4096) FROM n;
        PRAGMA wal_checkpoint(PASSIVE)",
    )?;
    let frames: i64 = db.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| row.get(1))?;
    assert!(frames > 2500);
    drop(db);
    wait_retired(&s, &before).await?;
    let modified = std::fs::metadata(&path)?.modified()?;
    let started = Instant::now();
    let reply = s.gw.get("/automations").await?;
    let first_read_us = started.elapsed().as_micros();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["automations"].as_array().unwrap().len(), 0);
    let db = sqlite::open(&path)?;
    let checkpointed: i64 = db.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| row.get(2))?;
    assert_eq!(checkpointed, frames);
    assert_eq!(
        std::fs::metadata(&path)?.modified()?,
        modified,
        "already-backfilled pages were rewritten"
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*), SUM(length(value)) FROM retirement_probe",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        )?,
        (2500, 10_240_000)
    );
    drop(db);
    let started = Instant::now();
    let reply =
        s.gw.post("/automations", schedule("First commit after idle"))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    eprintln!(
        "STORAGE-IDLE WAL frames={frames} first_read_us={first_read_us} first_commit_us={}",
        started.elapsed().as_micros()
    );
    assert_eq!(
        std::fs::metadata(&path)?.modified()?,
        modified,
        "first commit rewrote backfilled database pages"
    );
    assert_complete(&s, &[reply.data()["automation"].clone()]).await?;
    s.finish().await
}

#[tokio::test]
async fn idle_storage_closes_after_its_runtime_shuts_down() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("STORAGE-IDLE-RUNTIME")?;
    let path = setup.sandbox.root.join("runtime.sqlite");
    let s = setup
        .env("BUTLER_E2E_DISPATCH_FAULT", "runtime_shutdown")
        .env(
            "BUTLER_E2E_RUNTIME_STORAGE_PATH",
            path.to_string_lossy().into_owned(),
        )
        .start()
        .await?;
    let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_eq!(reply.data()["runs"], json!([]));
    assert!(
        std::fs::metadata(path.with_extension("sqlite-wal"))?.len() > 0,
        "runtime shutdown bypassed prepare_close and checkpointed the WAL"
    );
    let db = sqlite::open(path)?;
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?,
        42
    );
    drop(db);
    s.finish().await
}
