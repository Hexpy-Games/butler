//! App storage at the owner's data scale (SCENARIOS.md PERF-01).
//!
//! The App database of a long-lived install holds hundreds of chats, thousands
//! of terminal turns and hundreds of thousands of events. The scenario seeds a
//! synthetic database of that shape, then checks what the owner feels: a turn
//! is delivered as fast as on an empty database, a restart returns promptly
//! and settles only the turns that still need retention work, and a second
//! restart does no retention work at all.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use rusqlite::Connection;

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

const CHATS: u32 = 500;
const TURNS: u32 = 5_000;
/// The newest turns, still holding their progress events.
const UNCOMPACTED: u32 = 100;
const PROGRESS_EVENTS: u32 = 30;
/// Events per compacted turn; with the progress events, about 200k in all.
const TURN_EVENTS: u32 = 36;
const SEEDED_AT: &str = "2000-01-01 00:00:00";

fn database(s: &Scenario) -> Connection {
    Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap()
}

/// Seeds the owner-scale shape: `TURNS` terminal turns over `CHATS` chats whose
/// projections exist, except the first `UNCOMPACTED`, which still hold their
/// progress events and need compaction.
fn seed_owner_scale(db: &Connection) {
    db.execute_batch(
        "PRAGMA synchronous=OFF; BEGIN;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<499)
         INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
           SELECT 'perf-c'||i,'Chat '||i,'chat',0,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4999)
         INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at)
           SELECT 'perf-t'||i,'perf-c'||(i%500),'delivered','Delivered',
                  '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n;",
    )
    .unwrap();
    seed_events(db);
    db.execute_batch(&format!(
        "INSERT INTO app_terminal_turn_projections(turn_id,chat_id,terminal_state,
           progress_rows_json,delivery_metadata_json,source_event_high_water,compacted_at)
           SELECT t.id,t.chat_id,'delivered','[]',NULL,
                  (SELECT MAX(id) FROM events e WHERE e.turn_id=t.id AND e.turn_id<>''),'{SEEDED_AT}'
           FROM turns t WHERE {compacted};
         WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM k WHERE i<4)
         INSERT INTO app_terminal_turn_progress_rows(turn_id,source_event_id,row_json)
           SELECT t.id,10000000+t.rowid*10+k.i,'{{\"id\":\"row\",\"kind\":\"used_tool\"}}'
           FROM turns t, k WHERE {compacted};
         COMMIT;",
        compacted = compacted_turns(),
    ))
    .unwrap();
}

/// The events: progress rows of the uncompacted turns first (the oldest, so
/// outside the replay tail), then every turn's ordinary turn events.
fn seed_events(db: &Connection) {
    let text = "hex(zeroblob(200))";
    db.execute_batch(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<{last})
         INSERT INTO events(type,turn_id,payload_json,created_at)
           SELECT 'progress.summary','perf-t'||(i/{PROGRESS_EVENTS}),
             json_object('session_id','perf-c'||((i/{PROGRESS_EVENTS})%{CHATS}),
               'turn_id','perf-t'||(i/{PROGRESS_EVENTS}),
               'row',json_object('id','row-'||i,'kind','used_tool','state','running',
                 'safe_label',{text})),
             '2026-01-01T00:00:00.000Z' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<{turn_last})
         INSERT INTO events(type,turn_id,payload_json,created_at)
           SELECT 'agent.turn_event','perf-t'||(i/{TURN_EVENTS}),
             json_object('session_id','perf-c'||((i/{TURN_EVENTS})%{CHATS}),
               'turn_id','perf-t'||(i/{TURN_EVENTS}),
               'event',json_object('kind',
                 CASE WHEN i%{TURN_EVENTS}={TURN_EVENTS}-1 THEN 'turn.completed'
                      ELSE 'tool.progress' END,
                 'payload',json_object('text',{text}))),
             '2026-01-01T00:00:00.000Z' FROM n;",
        last = UNCOMPACTED * PROGRESS_EVENTS - 1,
        turn_last = TURNS * TURN_EVENTS - 1,
    ))
    .unwrap();
}

/// SQL over `turns t`: the seeded turns whose projections already exist.
fn compacted_turns() -> String {
    format!("t.id LIKE 'perf-t%' AND CAST(substr(t.id,7) AS INTEGER)>={UNCOMPACTED}")
}

fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Waits (bounded) until no seeded turn holds retention work.
async fn wait_retention_settled(s: &Scenario) -> Duration {
    let started = Instant::now();
    loop {
        let db = database(s);
        let pending = count(
            &db,
            "SELECT (SELECT COUNT(*) FROM events WHERE type='progress.summary')
                  + (SELECT COUNT(*) FROM turns t WHERE t.id LIKE 'perf-t%' AND NOT EXISTS
                       (SELECT 1 FROM app_terminal_turn_projections p WHERE p.turn_id=t.id))",
        );
        if pending == 0 {
            return started.elapsed();
        }
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "retention left {pending} items after {:?}",
            started.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Sends the numbers request and returns the time to a delivered turn.
async fn delivered_in(s: &Scenario) -> Result<Duration, HarnessError> {
    let started = Instant::now();
    let accepted = s.gw.say("general", NUMBERS).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(120))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok(started.elapsed())
}

/// The projection rows retention wrote or rewrote, as `turn:compacted_at`.
fn projection_stamps(db: &Connection) -> Vec<String> {
    let mut statement = db
        .prepare(
            "SELECT turn_id||'@'||compacted_at||'@'||source_event_high_water
             FROM app_terminal_turn_projections WHERE turn_id LIKE 'perf-t%' ORDER BY turn_id",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// PERF-01 — Owner-scale App database: delivery, restart and retention.
#[tokio::test]
async fn perf_01_owner_scale_delivery_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PERF-01")?.cassette("TURN-01").start().await?;
    let empty = delivered_in(&s).await?;
    s.agent.terminate().await?;
    seed_owner_scale(&database(&s));
    {
        let db = database(&s);
        assert!(count(&db, "SELECT COUNT(*) FROM events") >= 190_000);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM turns WHERE id LIKE 'perf-t%'"),
            5_000
        );
    }

    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let first_ready = started.elapsed();
    let at_scale = delivered_in(&s).await?;
    let settled = wait_retention_settled(&s).await;
    eprintln!(
        "PERF-01 empty turn {empty:?}; owner-scale start {first_ready:?}, turn {at_scale:?}, \
         retention settled {settled:?} after the turn"
    );
    // The projection of a delivered turn does not scale with the events table.
    assert!(
        at_scale < empty * 3 + Duration::from_secs(2),
        "delivery took {at_scale:?} at scale, {empty:?} on an empty database"
    );

    // Only the turns that needed work were compacted; the rest kept their rows.
    let db = database(&s);
    let rewritten = count(
        &db,
        &format!(
            "SELECT COUNT(*) FROM app_terminal_turn_projections
             WHERE turn_id LIKE 'perf-t%' AND compacted_at<>'{SEEDED_AT}'"
        ),
    );
    assert_eq!(
        rewritten,
        i64::from(UNCOMPACTED),
        "compacted the wrong turns"
    );
    let before = projection_stamps(&db);
    drop(db);

    // A second start finds nothing to do: no projection is rewritten.
    s.agent.terminate().await?;
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let second_ready = started.elapsed();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let db = database(&s);
    assert_eq!(
        projection_stamps(&db),
        before,
        "a restart re-compacted turns"
    );
    let watermark = count(&db, "SELECT turn_rowid FROM app_retention_sweep WHERE id=1");
    let seeded = count(&db, "SELECT MAX(rowid) FROM turns WHERE id LIKE 'perf-t%'");
    assert!(
        watermark >= seeded,
        "the sweep watermark {watermark} is behind the seeded turns"
    );
    eprintln!("PERF-01 second start ready in {second_ready:?}");
    s.finish().await
}
