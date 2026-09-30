//! Shutdown must finish an App queue admission that has already claimed input.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    provider::Pacing,
    scenario::{Setup, accepted_turn_id},
};
use rusqlite::Connection;
use serde_json::json;
use std::time::{Duration, Instant};

const LONG: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const WAITING: &str = "Reply with exactly the word: waiting";

#[tokio::test]
async fn q_02_shutdown_finishes_an_in_flight_queue_admission() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("Q-02-ADMISSION-SHUTDOWN")?
        .cassette("Q-02")
        .start()
        .await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 200,
    });
    s.agent.terminate().await?;
    let db = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    // Keep accept_turn's SQL in flight after its durable queue claim. The old
    // dispatcher drops the awaiting admission on shutdown; SQL still commits
    // a thinking turn, but the native enqueue never runs. This fixture uses
    // portable SQLite work, not a product timeout or a live model.
    db.execute_batch("CREATE TRIGGER slow_queued_admission AFTER UPDATE OF state ON turns
        WHEN NEW.state='thinking' AND EXISTS (
            SELECT 1 FROM messages WHERE id=NEW.user_message_id AND text='Reply with exactly the word: waiting')
        BEGIN
            SELECT sum(n) FROM (WITH RECURSIVE slow(n) AS (
                VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<8000000
            ) SELECT n FROM slow);
        END;").unwrap();
    s.gw = s.agent.start_again().await?;
    let first = accepted_turn_id(&s.gw.say("general", LONG).await?)?;
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general", "text":WAITING,
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    s.gw.wait_terminal("general", &first, Duration::from_secs(10))
        .await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let claimed: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session_queued_messages
            WHERE text=?1 AND state='dispatching')",
                [WAITING],
                |row| row.get(0),
            )
            .unwrap();
        if claimed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queued admission never claimed input: {:?}",
            db.prepare(
                "SELECT state, COALESCE(safe_error_code, ''), text FROM session_queued_messages"
            )
            .unwrap()
            .query_map([], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?
            )))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The claim is committed before accept_turn starts its slow SQL statement.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let published: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE text=?1 AND role='user')",
            [WAITING],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !published,
        "fixture missed the in-flight admission transaction"
    );
    s.agent.terminate().await?;
    db.execute_batch("DROP TRIGGER slow_queued_admission")
        .unwrap();
    drop(db);
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.len() == 2 && turns.iter().all(|turn| turn_state(turn) == "delivered") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queue admission stranded after restart: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let view = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(view.data()["paused"], false);
    assert!(
        view.data()["queued_messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 2);
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["role"] == "assistant" && m["text"] == "waiting")
            .count(),
        1
    );
    assert_eq!(s.provider()?.served(), 2);
    s.finish().await
}
