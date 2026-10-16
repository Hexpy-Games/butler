//! Opt-in synthetic PERF-CORR and PERF-1; no owner data.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::storage_correction::offline;
use super::storage_correction_seed as seed;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use serde_json::json;
use std::time::Instant;

#[tokio::test]
async fn acceptance_payload_perf_corr() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Ok(evidence) = std::env::var("BUTLER_CORRECTION_PERF_EVIDENCE") else {
        return Ok(());
    };
    let mut s = Setup::new("PERF-CORR")?
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    // Synthetic unfinished turns have no dispatchable checkpoint or claim.
    let db = Connection::open(&path)?;
    db.execute_batch("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES('corr-active','general','corr-active','corr-active','fixture','{}','constructed');
    INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES('corr-active','general','corr-active','corr-active','corr-active','Synthetic admitted','fixture','{}','{}','admitted',1,1);")?;
    drop(db);
    let (before, active, bytes) = offline(&path, |path| {
        seed::seed(path, &seed::Profile::owner(), "corr-active")?;
        let before = seed::snapshot(path)?;
        let active = seed::admitted(path, "corr-active")?;
        assert_eq!(active.len(), 162);
        let bytes = std::fs::metadata(path)?.len();
        assert!((6_400_000_000..6_900_000_000).contains(&bytes));
        Ok((before, active, bytes))
    })
    .await?;
    let unrelated = s.sandbox.root.join("cache-eviction.bin");
    offline(&unrelated, seed::evict_cache).await?;
    let start = Instant::now();
    s.gw = s.agent.start_again().await?;
    let ready = start.elapsed();
    let admitted = active.clone();
    let after = offline(&path, move |path| {
        seed::assert_correct(path, 15886 - 162, "corr-active", &admitted)?;
        seed::snapshot(path)
    })
    .await?;
    super::storage_correction::assert_snapshot(&before, &after);
    let logs = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
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
    let open = steps
        .iter()
        .filter(|line| line.contains("step=open "))
        .filter_map(|line| number(line, "duration_us="))
        .next_back()
        .unwrap();
    let correction = correction + open;
    let final_bytes = std::fs::metadata(&path)?.len();
    let live = 450_000_000 + active.iter().map(|s| s.len() as u64).sum::<u64>();
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let logs = std::fs::read_to_string(s.sandbox.logs.join("agent-3.log"))?;
    let noop = logs
        .lines()
        .filter(|l| l.contains("outcome=noop"))
        .filter_map(|l| number(l, "duration_us="))
        .next_back()
        .unwrap();
    let report = json!({"cache":"unrelated 20 GB file written and synced; no privileged page-cache drop", "seed_bytes":bytes,"final_bytes":final_bytes,"live_bytes":live,"ready_ms":ready.as_secs_f64()*1000.0,"correction_us":correction,"wal_bytes":wal,"second_correction_us":noop,"steps":steps,"gates":{"cold_120s":correction<=120_000_000,"wal_64mb":wal<=64*1024*1024,"final_1_2_live":final_bytes as f64<=live as f64*1.2,"second_50ms":noop<=50_000,"correctness":true}});
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

#[tokio::test]
async fn acceptance_payload_perf_1() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Ok(evidence) = std::env::var("BUTLER_ACCEPTANCE_PERF_EVIDENCE") else {
        return Ok(());
    };
    let baseline = std::env::var("BUTLER_ACCEPTANCE_PERF_BASELINE").as_deref() == Ok("1");
    let cache = std::env::var("BUTLER_ACCEPTANCE_PERF_CACHE")
        .unwrap_or_else(|_| "warm (not dropped)".into());
    let begin = Instant::now();
    let mut sandbox = Setup::new("PERF-1")?.sandbox;
    let (endpoint, script, server) =
        super::acceptance_payload::stub::start(sandbox.workspace.display().to_string(), 400)
            .await?;
    super::acceptance_payload::process::Process::start(&sandbox, &endpoint, 400, "init")?
        .finish()
        .await?;
    let setup_ms = begin.elapsed().as_secs_f64() * 1000.0;
    // Keep every WAL frame, including rounds that would otherwise be checkpointed.
    let pinned = super::data_perf::wal::Wal::pin(&sandbox.data, "round-store.sqlite")?;
    let before = pinned.sample()?;
    let begin = Instant::now();
    let mut child =
        super::acceptance_payload::process::Process::start(&sandbox, &endpoint, 400, "seed")?;
    super::acceptance_payload::process::wait(&script, &mut child).await?;
    let write_ms = begin.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(*script.requests.lock().unwrap(), vec![0, 400]);
    let path = sandbox.data.join("round-store.sqlite");
    let rows = super::acceptance_payload::rows(&path, "turn")?;
    assert_eq!(rows.len(), 400);
    let ids = Connection::open(&path)?
        .prepare(
            "SELECT round_id FROM btcc_model_round_acceptances WHERE turn_id='turn' ORDER BY rowid",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(
        ids,
        (0..400).map(|n| format!("round-{n}")).collect::<Vec<_>>()
    );
    assert_eq!(rows[0].1, 0);
    assert!(rows.iter().skip(1).all(|row| row.1 == i64::from(!baseline)));
    let bytes = rows
        .iter()
        .map(|r| r.2.len() + r.3.as_ref().map_or(0, String::len))
        .collect::<Vec<_>>();
    let (wal_bytes, commits) = pinned.delta(before)?;
    drop(pinned);
    // Cold memo, 400-row chain, one latest acceptance; measure through wire receipt.
    let (resumed, replay) =
        super::acceptance_payload::crash_replay(&sandbox, &script, &endpoint, &mut child, "latest")
            .await?;
    let written = super::acceptance_payload::report(&sandbox, "seed")?;
    let record_times: Vec<f64> = serde_json::from_value(written["write_ms"].clone())?;
    assert_eq!(record_times.len(), 400);
    assert!(record_times.iter().all(|ms| ms.is_finite() && *ms > 0.0));
    let loaded = super::acceptance_payload::report(&sandbox, "latest")?;
    let mut resumed = resumed;
    resumed.kill9()?;
    let input = script.input.lock().unwrap().clone();
    verify_input(&input)?;
    super::acceptance_payload::full_rows(&sandbox, "seed")?;
    let mut full =
        super::acceptance_payload::process::Process::start(&sandbox, &endpoint, 400, "latest")?;
    super::acceptance_payload::process::wait(&script, &mut full).await?;
    assert_eq!(
        *script.input.lock().unwrap(),
        input,
        "Full oracle changed wire input"
    );
    let reference = super::acceptance_payload::report(&sandbox, "latest")?;
    assert_eq!(
        loaded["hashes"], reference["hashes"],
        "latest load differs from Full oracle"
    );
    assert_eq!(written["hashes"].as_array().unwrap().len(), 400);
    let integrity: String =
        Connection::open(&path)?.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    assert_eq!(integrity, "ok");
    super::acceptance_payload::release(&script);
    full.finish().await?;
    let report = json!({"baseline":baseline,"cache":cache,
        "rounds":400,"setup_ms":setup_ms,"record_ms_per_round":record_times,
        "record_400_ms":record_times.iter().sum::<f64>(),
        "write_probe":write_probe(&sandbox.logs.join("seed.log"))?,"write_400_ms":write_ms,"replay_ms":replay.as_secs_f64()*1000.0,
        "open_ms":loaded["open_ms"],"reconstruct_ms":loaded["rounds_ms"],
        "payload_bytes":bytes.iter().sum::<usize>(),"payload_bytes_per_round":bytes,
        "wal_bytes":wal_bytes,"wal_bytes_per_round":wal_bytes as f64/400.0,"wal_commits":commits,
        "gates":{"replay_3s":replay.as_secs_f64()<=3.0,"wire_input_byte_identical":true,
        "serialized_result_identical":true,"round_count_and_order":true,"format":true,"integrity":true}});
    std::fs::write(&evidence, serde_json::to_vec_pretty(&report)?)?;
    eprintln!(
        "PERF-1 replay_ms={} payload_bytes={} wal_bytes={}",
        report["replay_ms"], report["payload_bytes"], wal_bytes
    );
    if !baseline {
        assert!(replay.as_secs_f64() <= 3.0, "replay exceeded 3s: {report}");
    }
    server.abort();
    sandbox.mark_success();
    Ok(())
}

fn verify_input(raw: &str) -> Result<(), HarnessError> {
    let input: serde_json::Value = serde_json::from_str(raw)?;
    let items = input.as_array().unwrap();
    let expected = (0..400)
        .map(|n| format!("acc-call-{n}"))
        .collect::<Vec<_>>();
    for kind in ["function_call", "function_call_output"] {
        let ids = items
            .iter()
            .filter(|item| item["type"] == kind)
            .map(|item| item["call_id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            ids, expected,
            "resend omitted, reordered or used stale items: {kind}"
        );
    }
    Ok(())
}

// Optional content-free timing probe from an instrumented storage build.
fn write_probe(path: &std::path::Path) -> Result<serde_json::Value, HarnessError> {
    let log = std::fs::read_to_string(path)?;
    let mut totals = std::collections::BTreeMap::<String, u64>::new();
    for line in log
        .lines()
        .filter(|line| line.starts_with("write_probe step="))
    {
        let step = line
            .split("step=")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap();
        let ns = number(line, "ns=").unwrap();
        *totals.entry(step.into()).or_default() += ns;
    }
    Ok(serde_json::to_value(totals)?)
}
