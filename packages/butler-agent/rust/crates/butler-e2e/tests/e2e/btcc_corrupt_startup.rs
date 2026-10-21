//! Persisted corruption verdicts fail closed without opening the recorded file.
mod recovery;
mod shutdown;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

const CORRUPTION: &str = "agent_btcc_storage_quick_check_failed";

pub(super) fn write_verdict(path: &Path, different: bool) -> Result<(), HarnessError> {
    std::fs::write(
        path.with_extension("sqlite.corrupt"),
        verdict_contents(path, different, CORRUPTION)?,
    )?;
    Ok(())
}

fn verdict_contents(path: &Path, different: bool, code: &str) -> Result<String, HarnessError> {
    let metadata = std::fs::metadata(path)?;
    let identity = butler_platform::secure_fs::identity(&metadata);
    let raw = serde_json::json!({
        "size": metadata.len() + u64::from(different),
        "modified": identity.modified.map(|time| (time.seconds, time.nanoseconds)),
        "file_id": identity.id.map(|id| (id.device, id.inode)),
    });
    Ok(format!("{code}\n{raw}"))
}

fn digest(path: &Path) -> Result<(u64, String), HarnessError> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

async fn failed_start(
    s: &mut butler_e2e::e2e::scenario::Scenario,
    generation: usize,
) -> Result<(Duration, String), HarnessError> {
    let started = Instant::now();
    s.agent.start_process()?;
    while s.agent.is_running() && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let elapsed = started.elapsed();
    assert!(!s.agent.is_running(), "flagged service must exit");
    assert!(s.agent.reap().is_some_and(|status| !status.success()));
    let log = std::fs::read_to_string(s.sandbox.logs.join(format!("agent-{generation}.log")))?;
    assert!(log.contains("storage_bootstrap_failed"), "{log}");
    assert!(!log.contains("[native-butler] ready"), "{log}");
    Ok((elapsed, log))
}

#[tokio::test]
async fn btcc_flagged_history_fails_fast_without_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BTCC-FLAGGED-SCALE")?
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    super::btcc_history::seed(&s.sandbox.data, 48)?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let before = digest(&path)?;
    write_verdict(&path, false)?;
    for (generation, legacy) in [(2, false), (3, true)] {
        if legacy {
            std::fs::write(path.with_extension("sqlite.corrupt"), CORRUPTION)?;
        }
        let verdict = std::fs::read(path.with_extension("sqlite.corrupt"))?;
        let (elapsed, log) = failed_start(&mut s, generation).await?;
        butler_e2e::assert_wall_clock_budget!(
            elapsed,
            Duration::from_secs(3),
            "flagged history BTCC startup"
        );
        assert!(
            log.contains(CORRUPTION),
            "existing corruption message: {log}"
        );
        assert!(
            !log.contains("activated_begin"),
            "must not open for validation: {log}"
        );
        assert_eq!(digest(&path)?, before, "DB must remain byte-identical");
        assert_eq!(
            std::fs::read(path.with_extension("sqlite.corrupt"))?,
            verdict
        );
        eprintln!(
            "flagged BTCC bytes={} legacy={legacy} failure_seconds={:.3} sha256={}",
            before.0,
            elapsed.as_secs_f64(),
            before.1
        );
    }
    s.sandbox.mark_success();
    Ok(())
}

async fn replaced_database(corrupt: bool) -> Result<(), HarnessError> {
    let mut s = Setup::new("BTCC-REPLACED-VERDICT")?
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    write_verdict(&path, false)?;
    // Restore a copy with an explicitly different mtime on every platform.
    let replacement = s.sandbox.root.join("replacement.sqlite");
    std::fs::copy(&path, &replacement)?;
    std::fs::File::options()
        .write(true)
        .open(&replacement)?
        .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000))?;
    std::fs::remove_file(&path)?;
    std::fs::rename(replacement, &path)?;
    if corrupt {
        Connection::open(&path)?.execute_batch(
            "PRAGMA foreign_keys=OFF;
            CREATE TABLE corrupt_parent(id INTEGER PRIMARY KEY);
            CREATE TABLE corrupt_child(id INTEGER REFERENCES corrupt_parent(id));
            INSERT INTO corrupt_child VALUES(123)",
        )?;
    }
    let before = digest(&path)?;
    let verdict = path.with_extension("sqlite.corrupt");
    if corrupt {
        let original = std::fs::read(&verdict)?;
        let (_, log) = failed_start(&mut s, 2).await?;
        assert!(log.contains("full_validation_begin"), "{log}");
        assert!(
            log.contains("agent_btcc_storage_foreign_key_check_failed"),
            "{log}"
        );
        let refreshed = std::fs::read(&verdict)?;
        assert_ne!(
            refreshed, original,
            "failed recovery must refresh the verdict"
        );
        assert!(
            String::from_utf8_lossy(&refreshed)
                .starts_with("agent_btcc_storage_foreign_key_check_failed\n{")
        );
        let (_, next) = failed_start(&mut s, 3).await?;
        assert!(!next.contains("activated_begin"), "{next}");
        assert_eq!(std::fs::read(&verdict)?, refreshed);
        assert_eq!(digest(&path)?, before);
    } else {
        s.gw = s.agent.start_again().await?;
        assert!(s.gw.healthy().await);
        let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
        assert!(log.contains("integrity_validated"), "{log}");
        assert!(!verdict.exists(), "only full validation clears verdict");
        s.agent.terminate().await?;
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn btcc_replaced_verdict_runs_full_validation_and_clears_on_pass() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    replaced_database(false).await
}

#[tokio::test]
async fn btcc_replaced_verdict_runs_full_validation_and_keeps_on_failure()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    replaced_database(true).await
}

#[tokio::test]
async fn unflagged_start_keeps_normal_readiness_deadline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BTCC-UNFLAGGED-DEADLINE")?
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    for generation in [1, 2] {
        let log = std::fs::read_to_string(s.sandbox.logs.join(format!("agent-{generation}.log")))?;
        assert!(
            log.contains("phase=readiness state=pending budget_ms=90000"),
            "ordinary startup must retain its 90 s deadline: {log}"
        );
        assert!(
            !log.contains("phase=readiness state=validating"),
            "unflagged and fresh starts must not receive recovery grace: {log}"
        );
    }
    s.finish().await
}
