use super::*;
use rusqlite::{Connection, params};
use std::time::Duration;

#[tokio::test]
async fn cancelling_queue_changes_and_idle_write_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-QUEUE-IDLE", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    let turn = first_turn(&s, &chat).await?;
    let canon = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let owner = butler_gateway::gateway::app_session_hint(&chat);
    // Reproduce the durable boundary after Stop was sent, before its receipt.
    // The real model request remains held; no runtime cancellation is sent.
    app.execute(
        "UPDATE turns SET state='cancelling',cancellable=0 WHERE id=?1",
        [&turn],
    )?;
    app.execute("INSERT INTO app_turn_cancel_outbox(turn_id,queue_id,state,created_at) VALUES(?1,'pending-receipt','accepted','2000-01-01T00:00:00Z')", [&turn])?;
    canon.execute("INSERT INTO canon_step_cancellations(op_id,epic_id,source_session_id) SELECT step_op_id,epic_id,session_id FROM canon_session_queue WHERE epic_id=?1", [&first])?;
    canon.execute(
        "UPDATE canon_session_queue SET state='held',held_by_epic_id=?1 WHERE epic_id=?2",
        params![epics[1], epics[2]],
    )?;
    let wake = data(
        s.gw.post("/sessions", json!({"title":"Unrelated","kind":"chat"}))
            .await?,
        201,
    );
    let wake = wake["session"]["id"].as_str().unwrap();
    // Finish initial projection before installing update counters. Unlike value
    // snapshots, these also detect UPDATEs which write the same values back.
    pulse(&s, wake).await?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    audit(&canon, "canon_session_queue", None)?;
    audit(&canon, "canon_session_queue_heads", None)?;
    audit(&canon, "canon_step_cancellations", None)?;
    audit(&app, "turns", Some(&chat))?;
    audit(&app, "session_queue_pauses", Some(&chat))?;
    let original_timestamps = timestamps(&app, &turn, &chat)?;
    for _ in 0..3 {
        pulse(&s, wake).await?;
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    let row_updates = (updates(&canon)?, updates(&app)?);
    eprintln!("CANON-IDLE unrelated changes: canon/App row updates={row_updates:?}");
    assert_eq!(
        row_updates,
        (0, 0),
        "unrelated changes must not rewrite canon or cancelling App rows"
    );
    assert_eq!(
        timestamps(&app, &turn, &chat)?,
        original_timestamps,
        "no timestamp churn"
    );
    let before = (version(&canon)?, version(&app)?);
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = (version(&canon)?, version(&app)?);
    eprintln!(
        "CANON-IDLE 60s: data_version before={before:?} after={after:?}; zero database commits"
    );
    assert_eq!(
        before, after,
        "idle canon and App databases must not be rewritten"
    );
    assert_eq!((updates(&canon)?, updates(&app)?), (0, 0));
    assert_eq!(timestamps(&app, &turn, &chat)?, original_timestamps);
    assert_eq!(
        canon.query_row::<i64, _, _>("SELECT count(*) FROM canon_step_cancellations", [], |r| r
            .get(0))?,
        1
    );
    for state in ["running", "held"] {
        assert!(
            canon.query_row::<i64, _, _>(
                "SELECT count(*) FROM canon_session_queue WHERE session_id=?1 AND state=?2",
                params![owner, state],
                |r| r.get(0)
            )? > 0
        );
    }
    drop((canon, app));
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn pulse(s: &butler_e2e::e2e::scenario::Scenario, chat: &str) -> Result<(), HarnessError> {
    let accepted = s.gw.say(chat, "What does this mean?").await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    s.gw.wait_terminal(chat, &turn, Duration::from_secs(30))
        .await?;
    Ok(())
}
fn audit(db: &Connection, table: &str, chat: Option<&str>) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS idle_updates(n INTEGER NOT NULL); INSERT INTO idle_updates SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM idle_updates);")?;
    let condition = chat
        .map(|id| format!("WHEN OLD.chat_id='{}'", id.replace('\'', "''")))
        .unwrap_or_default();
    db.execute_batch(&format!("CREATE TRIGGER idle_{table} AFTER UPDATE ON {table} {condition} BEGIN UPDATE idle_updates SET n=n+1; END;"))
}
fn updates(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT n FROM idle_updates", [], |r| r.get(0))
}
fn version(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("PRAGMA data_version", [], |r| r.get(0))
}
fn timestamps(
    db: &Connection,
    turn: &str,
    chat: &str,
) -> rusqlite::Result<(String, Option<String>)> {
    db.query_row("SELECT updated_at,(SELECT created_at FROM session_queue_pauses WHERE chat_id=?2) FROM turns WHERE id=?1", params![turn,chat], |r|Ok((r.get(0)?,r.get(1)?)))
}
