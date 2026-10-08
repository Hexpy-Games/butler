//! PERF-CORR opt-in synthetic 6.6 GB startup; no PR1 delta implementation.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::storage_correction_seed as seed;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn acceptance_payload_perf_corr() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Ok(evidence) = std::env::var("BUTLER_CORRECTION_PERF_EVIDENCE") else {
        return Ok(());
    };
    let mut s = Setup::new("PERF-CORR")?
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    // Synthetic unfinished turns have no dispatchable checkpoint or claim.
    let db = Connection::open(&path)?;
    db.execute_batch("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES('corr-active','general','corr-active','corr-active','fixture','{}','constructed');
    INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES('corr-active','general','corr-active','corr-active','corr-active','Synthetic admitted','fixture','{}','{}','admitted',1,1);")?;
    drop(db);
    seed::seed(&path, &seed::Profile::owner(), "corr-active")?;
    let before = seed::snapshot(&path)?;
    let active = seed::admitted(&path, "corr-active")?;
    assert_eq!(active.len(), 162);
    let bytes = std::fs::metadata(&path)?.len();
    assert!((6_400_000_000..6_900_000_000).contains(&bytes));
    if let Ok(ready) = std::env::var("BUTLER_CORRECTION_COLD_READY") {
        std::fs::write(&ready, b"ready")?;
        let resume = std::path::PathBuf::from(format!("{ready}.resume"));
        while !resume.exists() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    let start = Instant::now();
    s.gw = s.agent.start_again().await?;
    let ready = start.elapsed();
    seed::assert_correct(&path, 15886 - 162, "corr-active", &active)?;
    super::storage_correction::assert_snapshot(&before, &seed::snapshot(&path)?);
    let logs = s.agent.logs();
    let steps = logs
        .lines()
        .filter(|l| l.contains("phase=storage_correction"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let correction = steps
        .iter()
        .filter(|l| l.contains("outcome=compacted"))
        .filter_map(|l| number(l, "duration_us="))
        .next_back()
        .unwrap();
    let wal: u64 = steps
        .iter()
        .filter(|l| l.contains("step=reclaim_chunk"))
        .filter_map(|l| number(l, "wal_bytes="))
        .sum();
    let final_bytes = std::fs::metadata(&path)?.len();
    let live = 450_000_000 + active.iter().map(|s| s.len() as u64).sum::<u64>();
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let logs = s.agent.logs();
    let noop = logs
        .lines()
        .filter(|l| l.contains("step=outcome=noop"))
        .filter_map(|l| number(l, "duration_us="))
        .next_back()
        .unwrap();
    let report = json!({"seed_bytes":bytes,"final_bytes":final_bytes,"live_bytes":live,"ready_ms":ready.as_secs_f64()*1000.0,"correction_us":correction,"wal_bytes":wal,"second_correction_us":noop,"steps":steps,"gates":{"cold_120s":correction<=120_000_000,"wal_64mb":wal<=64*1024*1024,"final_1_2_live":final_bytes as f64<=live as f64*1.2,"second_50ms":noop<=50_000,"correctness":true}});
    std::fs::write(&evidence, serde_json::to_vec_pretty(&report)?)?;
    assert!(
        correction <= 120_000_000,
        "cold correction exceeded 120s: {report}"
    );
    assert!(
        wal <= 64 * 1024 * 1024,
        "reclaim WAL exceeded 64 MB: {report}"
    );
    assert!(
        final_bytes as f64 <= live as f64 * 1.2,
        "file exceeded 1.2× live: {report}"
    );
    assert!(noop <= 50_000, "no-op exceeded 50 ms: {report}");
    s.finish().await?;
    Ok(())
}
fn number(line: &str, key: &str) -> Option<u64> {
    line.split(key)
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}
