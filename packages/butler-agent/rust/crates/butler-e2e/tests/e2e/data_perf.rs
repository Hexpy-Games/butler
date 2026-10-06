//! Idle admission and SSD amplification with real service owners and terminal history.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::app_storage_scale::seed as app;
#[path = "support/btcc_scale.rs"]
mod btcc;
#[path = "support/btcc_validation_probe.rs"]
mod btcc_validation_probe;
use super::memory_fixture;
#[path = "support/transcript_scale.rs"]
mod transcripts;
#[path = "support/wal.rs"]
pub(super) mod wal;

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use butler_platform::process_control::usage;
use rusqlite::Connection;
use std::time::{Duration, Instant};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

#[tokio::test]
async fn perf_terminal_history_idle_and_turn_wal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("perf"),
        "requires perf tier and release agent"
    );
    let setup = Setup::new("PERF-DATA")?
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
        .cassette("TURN-01")
        .replay_only();
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    app::seed_owner_scale(
        &Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?,
        3_000,
    );
    seed_extra_app(&s.sandbox.data)?;
    btcc::seed(&s.sandbox.data)?;
    let transcripts = transcripts::seed(&s.sandbox.data)?;
    btcc_validation_probe::run(&s.sandbox.data)?;
    let start = Instant::now();
    s.gw = s.agent.start_again().await?;
    eprintln!("PERF-DATA seeded_owner_start={:?}", start.elapsed());
    eprintln!(
        "PERF-DATA first_owner_io={:?}",
        usage::sample(s.agent.pid().unwrap())?
    );
    btcc::assert_indexed(&s.sandbox.data)?;
    // Settle the initial retention pass; its completeness is checked below.
    tokio::time::sleep(Duration::from_secs(10)).await;
    s.agent.terminate().await?;
    let start = Instant::now();
    s.gw = s.agent.start_again().await?;
    eprintln!(
        "PERF-DATA warm_owner_start={:?} pid={}",
        start.elapsed(),
        s.agent.pid().unwrap()
    );
    tokio::time::sleep(Duration::from_secs(5)).await;
    let pins = pin_wals(&s.sandbox.data, &graph)?;
    let before = pins
        .iter()
        .map(wal::Wal::sample)
        .collect::<Result<Vec<_>, _>>()?;
    let io_before = usage::sample(s.agent.pid().unwrap())?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    let io_after = usage::sample(s.agent.pid().unwrap())?;
    for (pin, before) in pins.iter().zip(&before) {
        assert_eq!(pin.delta(*before)?, (0, 0), "{}: idle WAL writes", pin.name);
    }
    if let Some((a, b)) = io_before.zip(io_after) {
        let chars = b.read_chars.zip(a.read_chars).map(|(b, a)| b - a);
        let writes = b.write_chars.zip(a.write_chars).map(|(b, a)| b - a);
        eprintln!(
            "PERF-DATA idle_rchar={chars:?} idle_wchar={writes:?} read_bytes={} write_bytes={} rss={}",
            b.read_bytes - a.read_bytes,
            b.write_bytes - a.write_bytes,
            b.resident_bytes
        );
        assert!(
            chars.is_none_or(|value| value < 1_000_000) && b.read_bytes - a.read_bytes < 1_000_000
        );
        assert_eq!(b.write_bytes - a.write_bytes, 0);
        assert!(writes.is_none_or(|value| value == 0), "idle write syscalls");
    }
    btcc::assert_complete(&s.sandbox.data)?;
    transcripts::assert_complete(&s.sandbox.data, &transcripts)?;
    let latest_turn = measure_turns(&mut s, &pins, "owner").await?;
    drop(pins);
    btcc::assert_complete(&s.sandbox.data)?;
    transcripts::assert_complete(&s.sandbox.data, &transcripts)?;
    assert_app(&s.sandbox.data)?;
    for (index, run) in ["empty", "seeded", "warm"].iter().enumerate() {
        let log = std::fs::read_to_string(s.sandbox.logs.join(format!("agent-{}.log", index + 1)))?;
        for line in log
            .lines()
            .filter(|line| line.contains("[native-startup]") || line.contains("[btcc-startup]"))
        {
            eprintln!("PERF-DATA run={run} {line}");
        }
    }
    // Measure cold DATA and first index creation after preserving the independent
    // idle/turn evidence. The same readiness deadline still applies to this start.
    s.agent.terminate().await?;
    Connection::open(btcc::path(&s.sandbox.data))?.execute_batch(
        "DROP INDEX idx_btcc_turns_authority_waiting; DROP INDEX idx_btcc_subsession_outbox_pending;"
    )?;
    let cold_files = discard_fixture_pages(&s.sandbox.data)?;
    eprintln!("PERF-DATA cold_advice_files={cold_files}");
    let start = Instant::now();
    s.gw = s.agent.start_again().await?;
    eprintln!("PERF-DATA cold_owner_start={:?}", start.elapsed());
    btcc::assert_indexed(&s.sandbox.data)?;
    btcc::assert_complete(&s.sandbox.data)?;
    transcripts::assert_complete(&s.sandbox.data, &transcripts)?;
    assert_app(&s.sandbox.data)?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200);
    assert_view(view.data(), 3, &latest_turn)?;
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-4.log"))?;
    for line in log
        .lines()
        .filter(|line| line.contains("[native-startup]") || line.contains("[btcc-startup]"))
    {
        eprintln!("PERF-DATA run=cold {line}");
    }
    s.finish().await
}

// Independent storage baseline: owner-scale startup can fail without suppressing
// commit measurements. This test makes no owner-scale latency or I/O claim.
#[tokio::test]
async fn perf_replay_turn_wal_small_history() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("perf"),
        "requires perf tier and release agent"
    );
    let setup = Setup::new("PERF-WAL")?
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
        .cassette("TURN-01")
        .replay_only();
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    tokio::time::sleep(Duration::from_secs(10)).await;
    let pins = pin_wals(&s.sandbox.data, &graph)?;
    measure_turns(&mut s, &pins, "small_history").await?;
    drop(pins);
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
    for line in log
        .lines()
        .filter(|line| line.contains("[native-startup]") || line.contains("[btcc-startup]"))
    {
        eprintln!("PERF-DATA run=small_history {line}");
    }
    s.finish().await
}

fn pin_wals(
    data: &std::path::Path,
    graph: &std::path::Path,
) -> Result<Vec<wal::Wal>, HarnessError> {
    let mut paths = vec![
        "app-server/butler-client.sqlite",
        "agent-runtime/btcc.sqlite",
        "runtime/conversation-store.sqlite",
        "runtime/session-store.sqlite",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    paths.push(
        graph
            .strip_prefix(data)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    );
    paths
        .iter()
        .map(|path| wal::Wal::pin(data, path))
        .collect::<Result<Vec<_>, _>>()
}

async fn measure_turns(
    s: &mut Scenario,
    pins: &[wal::Wal],
    scope: &str,
) -> Result<String, HarnessError> {
    let mut latest_turn = String::new();
    for turn in 0..3 {
        let before = pins
            .iter()
            .map(wal::Wal::sample)
            .collect::<Result<Vec<_>, _>>()?;
        let start = Instant::now();
        let io_before = usage::sample(s.agent.pid().unwrap())?;
        let (turn_id, delivered) = s.turn("general", NUMBERS).await?;
        let delivery = start.elapsed();
        assert_eq!(
            butler_e2e::e2e::gateway::turn_state(&delivered),
            "delivered"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200);
        assert_view(view.data(), turn + 1, &turn_id)?;
        latest_turn = turn_id;
        if let Some((a, b)) = io_before.zip(usage::sample(s.agent.pid().unwrap())?) {
            eprintln!(
                "PERF-DATA scope={scope} turn={turn} storage_write_bytes={} delivery={delivery:?}",
                b.write_bytes - a.write_bytes
            );
        }
        for (pin, before) in pins.iter().zip(before) {
            let (bytes, commits) = pin.delta(before)?;
            eprintln!(
                "PERF-DATA scope={scope} turn={turn} db={} commits={commits} wal_bytes={bytes} elapsed={:?}",
                pin.name,
                start.elapsed()
            );
        }
    }
    Ok(latest_turn)
}

fn assert_view(
    view: &serde_json::Value,
    turns: usize,
    latest_turn: &str,
) -> Result<(), HarnessError> {
    assert_eq!(view["latest_turn"]["id"], latest_turn);
    assert_eq!(view["latest_turn"]["state"], "delivered");
    assert_eq!(view["message_window"]["complete"], true);
    assert_eq!(view["message_window"]["has_more"], false);
    let messages = view["messages"].as_array().unwrap();
    assert_eq!(messages.len(), turns * 2);
    let answer = Cassette::load("TURN-01")?.exchanges[0]
        .response
        .output_text();
    for pair in messages.chunks_exact(2) {
        assert_eq!(pair[0]["role"], "user");
        assert_eq!(pair[1]["role"], "assistant");
        assert_eq!(pair[0]["text"], NUMBERS);
        assert_eq!(pair[1]["text"], answer.trim());
    }
    assert!(
        messages
            .windows(2)
            .all(|pair| pair[0]["cursor"].as_u64().unwrap() < pair[1]["cursor"].as_u64().unwrap())
    );
    Ok(())
}

fn assert_app(data: &std::path::Path) -> Result<(), HarnessError> {
    let app = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    let projections: i64 = app.query_row(
        "SELECT COUNT(*) FROM app_terminal_turn_projections WHERE turn_id LIKE 'perf-t%'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(projections, 5_000);
    let events: i64 = app.query_row(
        "SELECT COUNT(*) FROM events WHERE type='agent.turn_event' AND turn_id LIKE 'perf-t%'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(events, 200_000);
    let extra: i64 = app.query_row(
        "SELECT COUNT(*) FROM events WHERE type='historical.fixture'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(extra, 100_000);
    let chats: i64 = app.query_row(
        "SELECT COUNT(*) FROM chats WHERE id LIKE 'perf-c%' OR id LIKE 'owner-extra-%'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(chats, 650);
    Ok(())
}

fn seed_extra_app(data: &std::path::Path) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch(
        "BEGIN;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<149)
        INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
        SELECT 'owner-extra-'||i,'Historical chat '||i,'chat',0,0,'2026-01-01','2026-01-01' FROM n;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<99999)
        INSERT INTO events(type,turn_id,payload_json,created_at)
        SELECT 'historical.fixture','','{}','2026-01-01' FROM n;
        COMMIT; PRAGMA wal_checkpoint(TRUNCATE);",
    )?;
    eprintln!(
        "PERF-APP database_bytes={}",
        std::fs::metadata(data.join("app-server/butler-client.sqlite"))?.len()
    );
    Ok(())
}

fn discard_fixture_pages(directory: &std::path::Path) -> Result<usize, HarnessError> {
    let mut count = 0;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            count += discard_fixture_pages(&entry.path())?;
        } else if kind.is_file() {
            let file = std::fs::File::open(entry.path())?;
            if let Some(result) = butler_platform::secure_fs::discard_cached_pages(&file) {
                result?;
                count += 1;
            }
        }
    }
    Ok(count)
}
