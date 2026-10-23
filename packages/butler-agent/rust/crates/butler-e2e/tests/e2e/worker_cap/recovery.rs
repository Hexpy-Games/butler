//! Pending admission survives a process exit before slot release.
use super::*;

#[tokio::test]
async fn cb_11_pending_worker_starts_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-RESTART", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    assert_eq!(rows[2]["status"], "waiting");
    // Exit before active turns can release slots during the shutdown drain.
    s.agent.kill9()?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let pending: String = db.query_row(
        "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
        [rows[2]["relation"]["relation_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(pending, "pending");
    drop(db);
    s.gw = s.agent.start_again().await?;
    started(&script, 3).await;
    script.release("red-2");
    closed(&s, rows[2]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
