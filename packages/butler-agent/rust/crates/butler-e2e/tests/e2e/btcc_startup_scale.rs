//! Opt-in real-process startup qualification with terminal owner-scale history.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::{Connection, params};
use std::path::Path;
use std::time::{Duration, Instant};
const DEFAULT_ROWS: i64 = 85_000;

#[tokio::test]
async fn btcc_startup_scale_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Ok(evidence) = std::env::var("BUTLER_BTCC_STARTUP_EVIDENCE") else {
        return Ok(());
    };
    let rows = std::env::var("BUTLER_BTCC_STARTUP_ROWS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_ROWS);
    assert!(rows >= DEFAULT_ROWS);
    let label = std::env::var("BUTLER_BTCC_STARTUP_LABEL").unwrap_or_else(|_| "after".into());
    let setup = Setup::new("BTCC-STARTUP-SCALE")?.env("BUTLER_E2E_STARTUP_TRACE", "1");
    let current = setup.sandbox.root.join("current-agent");
    butler_e2e::e2e::executable::copy(&setup.sandbox.binary, &current)?;
    let baseline = std::env::var("BUTLER_BTCC_BASELINE_BIN")
        .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?;
    butler_e2e::e2e::executable::copy(Path::new(&baseline), &setup.sandbox.binary)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    seed(&s.sandbox.data, rows)?;
    // A real origin/main service created this DB; it has no startup-health stamp.
    let db_path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&db_path)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    assert_eq!(version, 0);
    drop(db);
    assert!(!db_path.with_extension("sqlite.verified").exists());
    butler_e2e::e2e::executable::copy(&current, &s.sandbox.binary)?;
    let bytes = std::fs::metadata(&db_path)?.len();
    assert!(bytes >= 2_000_000_000);
    let mut measurements = Vec::new();
    for (run, kind) in [
        (1, "first-adoption"),
        (2, "unclean-exit"),
        (3, "clean-restart"),
    ] {
        let started = Instant::now();
        s.gw = s.agent.start_again().await?;
        let ready_elapsed = started.elapsed();
        let ready_ms = ready_elapsed.as_secs_f64() * 1000.0;
        butler_e2e::assert_wall_clock_budget!(ready_elapsed, Duration::from_secs(10), kind);
        assert!(s.gw.healthy().await);
        complete(&s.sandbox.data, rows)?;
        if run == 1 {
            let scan = concurrent_scan(&s.sandbox.data, &s.gw, rows).await?;
            measurements.push(serde_json::json!({"background_scan":scan}));
            s.agent.kill9()?;
        } else if run == 2 {
            let stamp = db_path.with_extension("sqlite.verified");
            let before = std::fs::read(&stamp)?;
            tokio::time::sleep(Duration::from_secs(3)).await;
            s.agent.terminate().await?;
            assert_eq!(
                std::fs::read(&stamp)?,
                before,
                "cancelled scan cannot verify"
            );
        } else {
            wait_verified(&db_path, &s.gw).await?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            let pid = s.agent.pid().unwrap();
            let before = butler_platform::process_control::usage::sample(pid)?.unwrap();
            tokio::time::sleep(Duration::from_secs(60)).await;
            let after = butler_platform::process_control::usage::sample(pid)?.unwrap();
            let writes = after.write_bytes - before.write_bytes;
            assert!(writes <= 1_000_000, "idle disk writes: {writes}");
            measurements.push(serde_json::json!({"idle_write_bytes_60s":writes}));
            complete(&s.sandbox.data, rows)?;
            s.agent.terminate().await?;
        }
        measurements.push(serde_json::json!({"run":run,"kind":kind,"ready_ms":ready_ms,"bytes":bytes,"rows":rows,"cache":"warm; no privileged cache purge"}));
        std::fs::write(
            Path::new(&evidence).join(format!("{label}-{run}.log")),
            std::fs::read(s.sandbox.logs.join(format!("agent-{}.log", run + 1)))?,
        )?;
    }
    std::fs::write(
        Path::new(&evidence).join(format!("{label}.json")),
        serde_json::to_vec_pretty(&measurements)?,
    )?;

    // The large fixture is removed by the sandbox's successful teardown.
    s.sandbox.mark_success();
    Ok(())
}

fn complete(data: &Path, rows: i64) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    for (table, key) in [
        ("btcc_turns", "turn_id"),
        ("btcc_inbound_inbox", "inbox_id"),
        ("btcc_session_relations", "relation_id"),
        ("btcc_subsession_outbox", "outbox_id"),
    ] {
        let (count, first, last): (i64, String, String) = db.query_row(
            &format!(
                "SELECT COUNT(*),MIN({key}),MAX({key}) FROM {table} WHERE {key} LIKE 'history-%'"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(count, rows);
        assert_eq!(first, "history-000000");
        assert_eq!(last, format!("history-{:06}", rows - 1));
    }
    for id in [
        "history-000000".to_owned(),
        format!("history-{:06}", rows - 1),
    ] {
        let body: String = db.query_row(
            "SELECT original_message FROM btcc_turns WHERE turn_id=?1",
            [id],
            |row| row.get(0),
        )?;
        assert_eq!(body, "x".repeat(23_000));
    }
    Ok(())
}

fn seed(data: &Path, rows: i64) -> Result<(), HarnessError> {
    let mut db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    // These are terminal historical rows. No recovery/model work is required.
    for start in (0..rows).step_by(5_000) {
        let tx = db.transaction()?;
        {
            let mut inbox = tx.prepare("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,'history',?1,?1,'fixture','{}','constructed')")?;
            let mut relation = tx.prepare("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal) VALUES(?1,'history',?1,?1,?1,?2,'Historical child','2026-01-01T00:00:00Z','steward',?1,1)")?;
            let mut turn = tx.prepare("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,'history',?1,?1,?1,?2,'fixture','{}','{}','delivered',1,1)")?;
            let mut outbox = tx.prepare("INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES(?1,?1,?1,'history',?1,?1,'{}','delivered','2026-01-01T00:00:00Z')")?;
            let body = "x".repeat(23_000);
            for index in start..(start + 5_000).min(rows) {
                let id = format!("history-{index:06}");
                inbox.execute([&id])?;
                relation.execute(params![id, index])?;
                turn.execute(params![id, body])?;
                outbox.execute([id])?;
            }
        }
        tx.commit()?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    }
    eprintln!(
        "PERF-BTCC database_bytes={}",
        std::fs::metadata(data.join("agent-runtime/btcc.sqlite"))?.len()
    );
    Ok(())
}

async fn concurrent_scan(
    data: &Path,
    gw: &butler_e2e::e2e::gateway::Gateway,
    rows: i64,
) -> Result<serde_json::Value, HarnessError> {
    let path = data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.busy_timeout(Duration::from_secs(2))?;
    db.execute_batch("PRAGMA wal_autocheckpoint=100; PRAGMA journal_size_limit=16777216")?;
    let start = Instant::now();
    let mut writes = 0;
    let mut peak = 0;
    while !path.with_extension("sqlite.verified").exists() {
        if start.elapsed() >= Duration::from_secs(180) {
            return Err(butler_e2e::e2e::harness_error("full scan did not finish"));
        }
        assert!(gw.healthy().await);
        db.execute(
            "INSERT INTO btcc_records VALUES(?1,'fixture','fixture',?2)",
            params![
                format!("scan-{writes}"),
                serde_json::to_string(&"y".repeat(65_534))?
            ],
        )?;
        writes += 1;
        peak = peak.max(std::fs::metadata(path.with_extension("sqlite-wal"))?.len());
        assert!(peak < 64_000_000, "WAL grew beyond bounded episode: {peak}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // PASSIVE never blocks serving and demonstrates snapshot release/recycling.
    for index in 0..20 {
        db.execute(
            "UPDATE btcc_records SET kind=?1 WHERE record_id='scan-0'",
            [format!("after-{index}")],
        )?;
        db.execute_batch("PRAGMA wal_checkpoint(PASSIVE)")?;
    }
    let end = std::fs::metadata(path.with_extension("sqlite-wal"))?.len();
    assert!(end <= 16_777_216, "WAL did not recycle: {end}");
    let (count, size): (i64, i64) = db.query_row(
        "SELECT COUNT(*),MIN(length(content_json)) FROM btcc_records WHERE record_id LIKE 'scan-%'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert_eq!(count, writes);
    assert_eq!(size, 65_536);
    let latest: String = db.query_row(
        "SELECT kind FROM btcc_records WHERE record_id='scan-0'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        latest, "after-19",
        "latest concurrent write must be preserved"
    );
    complete(data, rows)?;
    Ok(
        serde_json::json!({"duration_ms":start.elapsed().as_secs_f64()*1000.0,"writes":writes,"wal_peak_bytes":peak,"wal_recycled_bytes":end}),
    )
}

async fn wait_verified(
    path: &Path,
    gw: &butler_e2e::e2e::gateway::Gateway,
) -> Result<(), HarnessError> {
    let stamp = path.with_extension("sqlite.verified");
    let before = std::fs::read(&stamp).ok();
    let start = Instant::now();
    while std::fs::read(&stamp).ok() == before {
        if start.elapsed() >= Duration::from_secs(180) {
            return Err(butler_e2e::e2e::harness_error("full scan did not finish"));
        }
        assert!(gw.healthy().await);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}
