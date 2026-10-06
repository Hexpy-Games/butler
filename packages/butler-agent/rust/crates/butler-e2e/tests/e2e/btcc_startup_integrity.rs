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
    let db_path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    Connection::open(&db_path)?.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let good = s.sandbox.root.join("good.sqlite");
    std::fs::copy(&db_path, &good)?;
    if page {
        break_page(&s.sandbox.data)?;
    } else {
        break_fk(&s.sandbox.data, extra)?;
    }
    // Out-of-band corruption invalidates this fixture's previous verification.
    let _ = std::fs::remove_file(s.sandbox.data.join("agent-runtime/btcc.sqlite.verified"));
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
    assert!(
        !s.agent.is_running(),
        "still-corrupt verdict must fail after recheck"
    );
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_secs(3),
        "persisted corruption verdict"
    );
    let next = std::fs::read_to_string(s.sandbox.logs.join("agent-3.log"))?;
    assert!(next.contains("storage_bootstrap_failed"), "{next}");
    assert!(!next.contains("[native-butler] ready"), "{next}");
    assert!(next.contains("activated_begin"), "must recheck: {next}");
    assert!(!s.agent.reap().expect("failed restart exits").success());
    std::fs::copy(good, &db_path)?;
    for suffix in ["sqlite-wal", "sqlite-shm"] {
        let _ = std::fs::remove_file(db_path.with_extension(suffix));
    }
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    assert!(!sidecar.exists(), "repaired verdict must clear");
    let repaired = std::fs::read_to_string(s.sandbox.logs.join("agent-4.log"))?;
    assert!(repaired.contains("integrity_validated"), "{repaired}");
    assert!(repaired.contains("[native-butler] ready"), "{repaired}");
    save_corruption_logs(clean, page, extra, &log, &next, &repaired)?;
    s.agent.terminate().await?;
    s.sandbox.mark_success();
    Ok(())
}

fn save_corruption_logs(
    clean: bool,
    page: bool,
    extra: bool,
    first: &str,
    next: &str,
    repaired: &str,
) -> Result<(), HarnessError> {
    if let Ok(evidence) = std::env::var("BUTLER_BTCC_STARTUP_EVIDENCE") {
        for (kind, log) in [
            ("corruption", first),
            ("recheck", next),
            ("repaired", repaired),
        ] {
            std::fs::write(
                std::path::Path::new(&evidence).join(format!(
                    "round3-{kind}-clean-{clean}-page-{page}-extra-{extra}.log"
                )),
                log,
            )?;
        }
    }
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
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
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
        std::fs::write(std::path::Path::new(&evidence).join("round3-busy.log"), log)?;
    }
    let before = std::fs::read(&verified)?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(s.gw.healthy().await);
    assert_eq!(
        std::fs::read(&verified)?,
        before,
        "fresh verification must defer scan"
    );
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert!(!log.contains("phase=full_validation_begin"), "{log}");
    s.agent.terminate().await?;
    std::fs::write(&verified, "0:1")?;
    s.gw = s.agent.start_again().await?;
    let start = Instant::now();
    while std::fs::read(&verified)? == b"0:1" && start.elapsed() < Duration::from_secs(5) {
        assert!(s.gw.healthy().await);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_ne!(
        std::fs::read(&verified)?,
        b"0:1",
        "stale verification must run soon"
    );
    s.finish().await
}

#[tokio::test]
async fn btcc_full_scan_checks_foreign_keys_outside_btcc_tables() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    corruption(true, false, true).await
}

#[tokio::test]
async fn btcc_every_start_applies_migrations_with_existing_user_version() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("BTCC-MIGRATION-EVERY-START")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.execute_batch(
        "PRAGMA user_version=1;
        INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,
        origin_message_id,objective,status,created_at,updated_at)
        VALUES('stable','fixture','session','fixture','fixture','fixture','changed','completed','now','now');
        INSERT INTO btcc_guided_work_plan_revisions(plan_revision_id,work_id,revision,objective,
        governing_refs_json,actions_json,checks_json,origin_turn_id,created_at)
        VALUES('plan','stable',1,'original','[]','[]','[]','fixture','now');
        INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,
        anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal)
        VALUES('identity','fixture','fixture','fixture','fixture',1,'fixture','now','steward','wrong',1);",
    )?;
    drop(db);
    for _ in 0..2 {
        let db = Connection::open(&path)?;
        db.execute_batch(
            "UPDATE btcc_guided_works SET objective='changed'; UPDATE btcc_session_relations SET activity_worker_id='wrong'; DROP INDEX idx_btcc_work_monitor;",
        )?;
        drop(db);
        s.gw = s.agent.start_again().await?;
        assert!(s.gw.healthy().await);
        let db = Connection::open(&path)?;
        let objective: String = db.query_row(
            "SELECT objective FROM btcc_guided_works WHERE work_id='stable'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(objective, "original");
        let indexes: i64 = db.query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name='idx_btcc_work_monitor'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(indexes, 1);
        let identity: String = db.query_row(
            "SELECT activity_worker_id FROM btcc_session_relations WHERE relation_id='identity'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(identity, "steward-identity");
        drop(db);
        s.agent.terminate().await?;
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn btcc_verdict_recheck_preserves_reference_failure_and_repair() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BTCC-REFERENCE-RECHECK")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.execute_batch("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,
        original_message_id,original_message,admission_snapshot_ref,model_selection_json,
        context_json,semantic_state,revision,execution_fence)
        VALUES('reference','fixture','missing','reference','fixture','fixture','fixture','{}','{}','delivered',1,1)")?;
    drop(db);
    let verdict = path.with_extension("sqlite.corrupt");
    std::fs::write(&verdict, "agent_btcc_migration_reference_check_failed")?;
    s.agent.start_process()?;
    let start = Instant::now();
    while s.agent.is_running() && start.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!s.agent.is_running());
    assert!(
        !s.agent
            .reap()
            .expect("failed reference startup exits")
            .success()
    );
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert!(log.contains("storage_bootstrap_failed"), "{log}");
    assert!(
        log.contains("agent_btcc_migration_reference_check_failed"),
        "{log}"
    );
    assert!(!log.contains("[native-butler] ready"), "{log}");
    assert!(verdict.exists());
    let db = Connection::open(path)?;
    db.execute_batch(
        "INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,
        admission_input_hash,command_json,status)
        VALUES('missing','fixture','reference','reference','fixture','{}','constructed')",
    )?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    assert!(!verdict.exists());
    s.finish().await
}
