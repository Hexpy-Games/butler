//! Persisted corruption verdicts fail closed without opening the recorded file.
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
    let metadata = std::fs::metadata(path)?;
    let identity = butler_platform::secure_fs::identity(&metadata);
    let raw = serde_json::json!({
        "size": metadata.len() + u64::from(different),
        "modified": identity.modified.map(|time| (time.seconds, time.nanoseconds)),
        "file_id": identity.id.map(|id| (id.device, id.inode)),
    });
    std::fs::write(
        path.with_extension("sqlite.corrupt"),
        format!("{CORRUPTION}\n{raw}"),
    )?;
    Ok(())
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
async fn btcc_flagged_owner_scale_fails_fast_without_mutation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BTCC-FLAGGED-SCALE")?
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    super::btcc_startup_scale::seed(&s.sandbox.data, 300_000)?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let before = digest(&path)?;
    assert!(before.0 >= 7_000_000_000, "owner-scale fixture required");
    write_verdict(&path, false)?;
    for (generation, legacy) in [(2, false), (3, true)] {
        if legacy {
            std::fs::write(path.with_extension("sqlite.corrupt"), CORRUPTION)?;
        }
        let verdict = std::fs::read(path.with_extension("sqlite.corrupt"))?;
        let (elapsed, log) = failed_start(&mut s, generation).await?;
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
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
    // Replace the file with an equal-size copy: the file ID, rather than size,
    // must distinguish it on hosts that expose IDs. Modification time is also recorded.
    let replacement = s.sandbox.root.join("replacement.sqlite");
    std::fs::copy(&path, &replacement)?;
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
        assert_eq!(std::fs::read(&verdict)?, original);
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
