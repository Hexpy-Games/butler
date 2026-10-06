//! Startup and deferred validation must share the existing corruption exit path.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use std::time::{Duration, Instant};

fn break_fk(data: &std::path::Path) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch(
        "PRAGMA foreign_keys=OFF;
        INSERT INTO btcc_subsession_directions(instruction_id,relation_id,revision,
        source_parent_turn_id,source_message_id,instruction,status,created_at)
        VALUES('corrupt','missing',1,'parent','message','fixture','applied','2026-10-06')",
    )?;
    Ok(())
}

async fn corruption(clean: bool, page: bool) -> Result<(), HarnessError> {
    let mut s = Setup::new(if clean {
        "BTCC-CLEAN-CORRUPT"
    } else {
        "BTCC-DIRTY-CORRUPT"
    })?
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
        break_fk(&s.sandbox.data)?;
    }
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let marker: bool = db.query_row("SELECT clean=1 FROM agent_storage_health", [], |row| {
        row.get(0)
    })?;
    assert_eq!(marker, clean);
    drop(db);
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
    assert_eq!(log.contains("[native-butler] ready"), clean, "{log}");
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let dirty: bool = db.query_row("SELECT clean=0 FROM agent_storage_health", [], |row| {
        row.get(0)
    })?;
    // The failed dirty-start scan leaves its existing dirty marker untouched.
    assert!(
        dirty,
        "failed validation must never publish a clean shutdown"
    );
    let status = s.agent.reap().expect("failed service exits");
    assert!(
        !status.success(),
        "corruption must use the service failure exit"
    );
    if let Ok(evidence) = std::env::var("BUTLER_BTCC_STARTUP_EVIDENCE") {
        std::fs::write(
            std::path::Path::new(&evidence)
                .join(format!("corruption-clean-{clean}-page-{page}.log")),
            log,
        )?;
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn btcc_unclean_start_reports_corruption_before_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(false, false).await
}

#[tokio::test]
async fn btcc_clean_start_reports_deferred_corruption_after_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(true, false).await
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
    corruption(false, true).await
}

#[tokio::test]
async fn btcc_clean_start_detects_damaged_page_after_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(true, true).await
}
