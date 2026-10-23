//! Recovery validation outlives the normal readiness deadline and seals failure.
use super::*;

#[tokio::test]
async fn history_recovery_validation_outlives_readiness_deadline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BTCC-RECOVERY-DEADLINE")?
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    super::super::btcc_history::seed(&s.sandbox.data, 48)?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    Connection::open(&path)?.execute_batch(
        "PRAGMA foreign_keys=OFF;
        CREATE TABLE damaged_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE damaged_child(id INTEGER REFERENCES damaged_parent(id));
        INSERT INTO damaged_child VALUES(123);
        PRAGMA wal_checkpoint(TRUNCATE)",
    )?;
    write_verdict(&path, true)?;
    let before = digest(&path)?;
    let verdict = path.with_extension("sqlite.corrupt");
    let original = std::fs::read(&verdict)?;
    let release = s.sandbox.root.join("validation-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "btcc_validation");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
    s.agent.start_process()?;
    let started = Instant::now();
    let held = release.with_extension("held");
    while !held.exists() && started.elapsed() < Duration::from_secs(15) {
        assert!(s.agent.is_running(), "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(held.exists(), "recovery must reach validation barrier");
    let validating = Instant::now();
    // Deliberately cross the unchanged 90 s service deadline at a known phase.
    while validating.elapsed() < Duration::from_secs(91) {
        assert!(s.agent.is_running(), "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(s.agent.is_running(), "validation must extend readiness");
    assert_eq!(std::fs::read(&verdict)?, original);
    std::fs::write(&release, b"release")?;
    while s.agent.is_running() && started.elapsed() < Duration::from_secs(270) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !s.agent.is_running(),
        "recovery must finish within its bounded grace"
    );
    assert!(s.agent.reap().is_some_and(|status| !status.success()));
    let elapsed = started.elapsed();
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert!(log.contains("full_validation_begin"), "{log}");
    assert!(
        log.contains("phase=readiness state=validating budget_ms=270000"),
        "full recovery validation must receive bounded grace: {log}"
    );
    assert!(log.contains("storage_bootstrap_failed"), "{log}");
    assert!(
        log.contains("agent_btcc_storage_foreign_key_check_failed"),
        "{log}"
    );
    assert!(!log.contains("native_service_start_timeout"), "{log}");
    let refreshed = std::fs::read(&verdict)?;
    assert_ne!(
        refreshed, original,
        "failed recovery must seal current identity"
    );
    assert_eq!(digest(&path)?, before, "recovery must not mutate the DB");
    let (next_elapsed, next) = failed_start(&mut s, 3).await?;
    assert!(!next.contains("activated_begin"), "{next}");
    assert_eq!(std::fs::read(&verdict)?, refreshed);
    eprintln!(
        "recovery bytes={} validation_seconds={:.3} next_failure_seconds={:.3}",
        before.0,
        elapsed.as_secs_f64(),
        next_elapsed.as_secs_f64()
    );
    s.sandbox.mark_success();
    Ok(())
}
