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

use butler_platform::sqlite;
use std::time::{Duration, Instant};

use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, cassette::Cassette};
use rusqlite::Connection;

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

#[path = "app_storage_scale/seed.rs"]
mod seed;
use seed::{SEEDED_AT, UNCOMPACTED, seed_owner_scale};

fn database(s: &Scenario) -> Connection {
    sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap()
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
            butler_e2e::assert_wall_clock_budget!(
                started.elapsed(),
                Duration::from_secs(120),
                "retention left"
            );
            return started.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Sends the numbers request and returns the time to a delivered turn.
async fn delivered_in(s: &Scenario) -> Result<(Duration, String), HarnessError> {
    let started = Instant::now();
    let accepted = s.gw.say("general", NUMBERS).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(120))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok((started.elapsed(), turn_id))
}

async fn session_view_p95(s: &Scenario, latest_turn: &str) -> Result<Duration, HarnessError> {
    let answer = Cassette::load("TURN-01")?.exchanges[0]
        .response
        .output_text();
    let mut samples = Vec::with_capacity(20);
    for _ in 0..20 {
        let started = Instant::now();
        let reply = s.gw.get("/session-view?session_id=general").await?;
        samples.push(started.elapsed());
        assert_eq!(reply.status, 200, "{}", reply.text);
        let view = reply.data();
        assert_eq!(view["session_id"], "general");
        assert_eq!(view["latest_turn"]["id"], latest_turn);
        assert_eq!(view["latest_turn"]["state"], "delivered");
        assert!(view["active_turn"].is_null());
        for field in [
            "pending_questions",
            "question_answers",
            "authority_requests",
        ] {
            assert_eq!(view[field], serde_json::json!([]), "{field}: {view}");
        }
        assert_eq!(view["message_window"]["complete"], true);
        assert_eq!(view["message_window"]["has_more"], false);
        let messages = view["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4, "{view}");
        for pair in messages.chunks_exact(2) {
            assert_eq!(pair[0]["role"], "user");
            assert_eq!(pair[0]["text"], NUMBERS);
            assert_eq!(pair[1]["role"], "assistant");
            assert_eq!(pair[1]["text"], answer.trim());
        }
        assert!(messages.windows(2).all(|pair| {
            pair[0]["cursor"].as_u64().unwrap() < pair[1]["cursor"].as_u64().unwrap()
        }));
    }
    samples.sort();
    eprintln!(
        "PERF-01 session-view p50 {:?}; p95 {:?}",
        samples[9], samples[18]
    );
    Ok(samples[18])
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
    let (empty, _) = delivered_in(&s).await?;
    s.agent.terminate().await?;
    seed_owner_scale(&database(&s), 200);
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
    let (at_scale, latest_turn) = delivered_in(&s).await?;
    let view_p95 = session_view_p95(&s, &latest_turn).await?;
    eprintln!(
        "PERF-01 empty turn {empty:?}; owner-scale start {first_ready:?}, turn {at_scale:?}, session-view p95 {view_p95:?}"
    );
    let settled = wait_retention_settled(&s).await;
    eprintln!(
        "PERF-01 empty turn {empty:?}; owner-scale start {first_ready:?}, turn {at_scale:?}, \
         session-view p95 {view_p95:?}, retention settled {settled:?} after the turn"
    );
    butler_e2e::assert_wall_clock_budget!(view_p95, Duration::from_millis(150), "session-view p95");
    // The projection of a delivered turn does not scale with the events table.
    butler_e2e::assert_wall_clock_budget!(
        at_scale,
        empty * 3 + Duration::from_secs(2),
        "delivery took"
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
