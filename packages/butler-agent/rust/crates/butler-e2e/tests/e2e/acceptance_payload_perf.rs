//! Opt-in synthetic PERF-CORR and PERF-1; no owner data.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use serde_json::json;
use std::time::Instant;

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
