//! Older builds' post-result directions must not reopen ended Worker cards.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn cb_11_historical_post_result_directions_retire_on_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-HISTORICAL-CAP", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    started(&script, 3).await;
    script.release("red-1");
    closed(&s, rows[1]["session_id"].as_str().unwrap()).await?;
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.agent.kill9()?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for (n, row) in rows.iter().take(2).enumerate() {
        let relation = row["relation"]["relation_id"].as_str().unwrap();
        db.execute("INSERT INTO btcc_subsession_directions (instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) VALUES (?1,?2,1,'historical-turn',?1,'Verify the updated source','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second'))", rusqlite::params![format!("historical-{n}"),relation])?;
        db.execute(
            "UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1",
            [relation],
        )?;
    }
    s.gw = s.agent.start_again().await?;
    for row in rows.iter().take(2) {
        let relation = row["relation"]["relation_id"].as_str().unwrap();
        let session = row["session_id"].as_str().unwrap();
        let pending: i64 = db.query_row("SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'", [relation], |r| r.get(0))?;
        let turns: i64 = db.query_row(
            "SELECT count(*) FROM btcc_turns WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        assert_eq!(pending, 0);
        assert_eq!(
            turns, 1,
            "ended Worker must not acquire a continuation on recovery"
        );
        assert!(butler_turn::btcc::storage::terminal_card_invariant(&db, session).unwrap());
    }
    script.release("red-2");
    script.fourth.add_permits(1);
    script.release("red-3");
    s.finish().await?;
    server.abort();
    Ok(())
}
