//! Startup and deferred validation must share the existing corruption exit path.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use std::time::{Duration, Instant};

fn break_fk(data: &std::path::Path, extra: bool) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    if extra {
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
            CREATE TABLE agent_fk_parent(id INTEGER PRIMARY KEY);
            CREATE TABLE agent_fk_child(parent INTEGER REFERENCES agent_fk_parent(id));
            INSERT INTO agent_fk_child VALUES(999)",
        )?;
        return Ok(());
    }
    db.execute_batch(
        "PRAGMA foreign_keys=OFF;
        INSERT INTO btcc_subsession_directions(instruction_id,relation_id,revision,
        source_parent_turn_id,source_message_id,instruction,status,created_at)
        VALUES('corrupt','missing',1,'parent','message','fixture','applied','2026-10-06')",
    )?;
    Ok(())
}

async fn corruption(clean: bool, page: bool, extra: bool) -> Result<(), HarnessError> {
    let mut s = Setup::new(if clean {
        "BTCC-CLEAN-CORRUPT"
    } else {
        "BTCC-DIRTY-CORRUPT"
    })?
    .env("BUTLER_E2E_STARTUP_TRACE", "1")
    .start()
    .await?;
    if clean {
        s.agent.terminate().await?;
    } else {
        s.agent.kill9()?;
    }
    if page {
        break_page(&s.sandbox.data)?;
    } else {
        break_fk(&s.sandbox.data, extra)?;
    }
    s.agent.start_process()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.agent.is_running() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!s.agent.is_running(), "corrupt service remained alive");
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert!(
        if page {
            log.contains("malformed") || log.contains("agent_btcc_storage_quick_check_failed")
        } else {
            log.contains("agent_btcc_storage_foreign_key_check_failed")
        },
        "{log}"
    );
    assert!(log.contains("[native-butler] ready"), "{log}");
    let sidecar = s.sandbox.data.join("agent-runtime/btcc.sqlite.corrupt");
    assert!(sidecar.is_file(), "corruption verdict must survive restart");
    let status = s.agent.reap().expect("failed service exits");
    assert!(
        !status.success(),
        "corruption must use the service failure exit"
    );
    s.agent.start_process()?;
    let started = Instant::now();
    while s.agent.is_running() && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!s.agent.is_running(), "persisted verdict must fail fast");
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_secs(3),
        "persisted corruption verdict"
    );
    let next = std::fs::read_to_string(s.sandbox.logs.join("agent-3.log"))?;
    assert!(next.contains("persisted corruption verdict"), "{next}");
    assert!(!next.contains("[native-butler] ready"), "{next}");
    assert!(!next.contains("activated_begin"), "must not rescan: {next}");
    assert!(!s.agent.reap().expect("failed restart exits").success());
    if let Ok(evidence) = std::env::var("BUTLER_BTCC_STARTUP_EVIDENCE") {
        eprintln!(
            "BTCC persisted-verdict clean={clean} page={page} fast_ms={}",
            started.elapsed().as_secs_f64() * 1000.0
        );
        std::fs::write(
            std::path::Path::new(&evidence).join(format!(
                "round2-fast-clean-{clean}-page-{page}-extra-{extra}.log"
            )),
            next,
        )?;
        std::fs::write(
            std::path::Path::new(&evidence).join(format!(
                "round2-corruption-clean-{clean}-page-{page}-extra-{extra}.log"
            )),
            log,
        )?;
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn btcc_unclean_start_reports_deferred_corruption_after_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(false, false, false).await
}

#[tokio::test]
async fn btcc_clean_start_reports_deferred_corruption_after_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(true, false, false).await
}

fn break_page(data: &std::path::Path) -> Result<(), HarnessError> {
    use std::io::{Seek, SeekFrom, Write};
    let path = data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let root: u64 = db.query_row(
        "SELECT rootpage FROM sqlite_schema WHERE name='btcc_records'",
        [],
        |row| row.get(0),
    )?;
    let size: u64 = db.pragma_query_value(None, "page_size", |row| row.get(0))?;
    drop(db);
    let mut file = std::fs::OpenOptions::new().write(true).open(path)?;
    file.seek(SeekFrom::Start((root - 1) * size))?;
    file.write_all(&[0])?; // invalid b-tree page type, outside the schema/header pages
    file.sync_all()?;
    Ok(())
}

#[tokio::test]
async fn btcc_unclean_start_detects_damaged_page() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(false, true, false).await
}

#[tokio::test]
async fn btcc_clean_start_detects_damaged_page_after_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(true, true, false).await
}

#[tokio::test]
async fn btcc_busy_scan_retries_without_stopping_service() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BTCC-SCAN-BUSY")?;
    let marker = setup.sandbox.root.join("busy-injected");
    let mut s = setup
        .env("BUTLER_E2E_FILE_FAULT", "btcc_scan_busy")
        .env("BUTLER_E2E_FILE_FAULT_MARKER", marker.to_string_lossy())
        .start()
        .await?;
    let verified = s.sandbox.data.join("agent-runtime/btcc.sqlite.verified");
    let started = Instant::now();
    while !verified.exists() && started.elapsed() < Duration::from_secs(15) {
        assert!(s.agent.is_running());
        assert!(s.gw.healthy().await);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(verified.exists(), "transient BUSY must be retried");
    assert!(marker.exists());
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
    assert!(
        log.contains("DatabaseBusy") && log.contains("backoff_s=5"),
        "{log}"
    );
    assert!(!log.contains("storage_bootstrap_failed"), "{log}");
    if let Ok(evidence) = std::env::var("BUTLER_BTCC_STARTUP_EVIDENCE") {
        std::fs::write(std::path::Path::new(&evidence).join("round2-busy.log"), log)?;
    }
    s.finish().await
}

#[tokio::test]
async fn btcc_full_scan_checks_foreign_keys_outside_btcc_tables() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(true, false, true).await
}
