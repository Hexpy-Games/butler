//! A deferred corruption exit must seal identity after active-turn commits.
use super::*;
use butler_e2e::e2e::{
    cassette::{Cassette, Chunk},
    provider::Pacing,
};

#[tokio::test]
async fn corruption_during_writes_and_active_turn_seals_final_identity() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TURN-03")?;
    cassette.exchanges.truncate(1);
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    cassette.exchanges[0].response.chunks = cassette.exchanges[0]
        .response
        .body()
        .split("\n\n")
        .filter(|text| !text.is_empty())
        .enumerate()
        .map(|(index, text)| Chunk {
            delay_ms: if index < 5 { 0 } else { 5_000 },
            text: format!("{text}\n\n"),
        })
        .collect();
    let setup = Setup::new("BTCC-CORRUPTION-DRAIN")?;
    let marker = setup.sandbox.root.join("scan-busy");
    let mut s = setup
        .stub_cassette(cassette)
        .env("BUTLER_STARTUP_TRACE", "1")
        .env("BUTLER_E2E_FILE_FAULT", "btcc_scan_busy")
        .env("BUTLER_E2E_FILE_FAULT_MARKER", marker.to_string_lossy())
        .start()
        .await?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while !marker.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(marker.exists(), "initial scan must reach the BUSY seam");
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    db.execute_batch(
        "PRAGMA foreign_keys=OFF;
        CREATE TABLE damaged_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE damaged_child(id INTEGER REFERENCES damaged_parent(id));
        INSERT INTO damaged_child VALUES(123);
        PRAGMA wal_checkpoint(TRUNCATE)",
    )?;
    drop(db);
    let _ = std::fs::remove_file(path.with_extension("sqlite.verified"));
    std::fs::remove_file(&marker)?;
    let release = s.sandbox.root.join("scan-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "btcc_validation");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
    s.gw = s.agent.start_again().await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 30_000,
        min_ms: 0,
    });
    let accepted = s.gw.say("general", &prompt).await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while s.provider()?.served() == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(s.provider()?.served(), 1, "turn must be streaming");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !release.with_extension("held").exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(release.with_extension("held").exists(), "scan must be held");
    let reader = Connection::open(&path)?;
    reader.execute_batch("BEGIN; SELECT COUNT(*) FROM btcc_records")?;
    let writer = Connection::open(&path)?;
    writer.execute_batch("PRAGMA wal_autocheckpoint=0")?;
    let started = Instant::now();
    let mut writes = 0;
    let verdict = path.with_extension("sqlite.corrupt");
    while std::fs::metadata(path.with_extension("sqlite-wal"))?.len() <= 16_777_216
        && started.elapsed() < Duration::from_secs(15)
    {
        writer.execute(
            "INSERT INTO btcc_records VALUES(?1,'fixture','fixture',?2)",
            rusqlite::params![format!("concurrent-{writes}"), "x".repeat(1_000_000)],
        )?;
        writes += 1;
    }
    assert!(
        std::fs::metadata(path.with_extension("sqlite-wal"))?.len() > 16_777_216,
        "WAL must grow past the checkpoint ceiling before releasing validation"
    );
    // External commits do not invoke the agent's WAL hook. Release both handles
    // before validation resumes, leaving the drain commit to checkpoint the WAL.
    drop(reader);
    drop(writer);
    assert!(
        !verdict.exists(),
        "scan cannot finish before handle release"
    );
    let scan_verdict =
        verdict_contents(&path, false, "agent_btcc_storage_foreign_key_check_failed")?;
    std::fs::write(&release, b"release")?;
    while s.agent.is_running() && started.elapsed() < Duration::from_secs(20) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!s.agent.is_running());
    assert!(s.agent.reap().is_some_and(|status| !status.success()));
    let final_verdict = std::fs::read_to_string(&verdict)?;
    let (code, final_identity) = final_verdict.split_once('\n').unwrap_or_default();
    assert_eq!(code, "agent_btcc_storage_foreign_key_check_failed");
    let (_, scan_identity) = scan_verdict.split_once('\n').unwrap_or_default();
    assert_ne!(
        serde_json::from_str::<serde_json::Value>(final_identity)?,
        serde_json::from_str::<serde_json::Value>(scan_identity)?,
        "shutdown checkpoint must change the recorded identity"
    );
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    assert!(
        log.contains("agent_btcc_storage_foreign_key_check_failed"),
        "{log}"
    );
    let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_records WHERE record_id LIKE 'concurrent-%'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(count, writes, "all concurrent writes survive");
    drop(db);
    let app = Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let settled: (String, String) = app.query_row(
        "SELECT state,safe_error_code FROM turns WHERE id=?1",
        [&turn],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert_eq!(settled, ("failed".into(), "turn_interrupted".into()));
    drop(app);
    let (_, next) = failed_start(&mut s, 3).await?;
    assert!(
        !next.contains("activated_begin"),
        "final identity must fail fast: {next}"
    );
    s.sandbox.mark_success();
    Ok(())
}
