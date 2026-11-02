//! Main's historical enqueued rows re-enter capped admission on restart.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn cb_11_historical_enqueued_continuations_respect_cap_on_restart() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-HISTORICAL-CAP", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    script.hold_continuation.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (parent, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    started(&script, 3).await;
    script.release("red-1");
    closed(&s, rows[1]["session_id"].as_str().unwrap()).await?;
    s.patch_settings(json!({"max_simultaneous_workers":1}), "lower cap")
        .await?;
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_pending_direction(&s, &rows[0])?;
    s.agent.kill9()?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let first = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let second = rows[1]["relation"]["relation_id"].as_str().unwrap();
    db.execute("INSERT INTO btcc_subsession_directions (instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) VALUES ('historical-direction',?1,1,'historical-turn','historical-message','Verify the updated source','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second'))", [second])?;
    db.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id IN (?1,?2)", rusqlite::params![first,second])?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    tokio::time::timeout(Duration::from_secs(30), script.continued.wait())
        .await
        .unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let running: u64 = db.query_row(
        butler_turn::btcc::storage::RUNNING_WORKERS_SQL,
        [&parent],
        |r| r.get(0),
    )?;
    assert_eq!(running, 1);
    let state: String = db.query_row(
        "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
        [second],
        |r| r.get(0),
    )?;
    assert_eq!(state, "pending");
    script.continuation_release.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let complete: u64 = db.query_row("SELECT count(DISTINCT x.relation_id) FROM btcc_steward_results x JOIN btcc_subsession_delegations d USING(relation_id) WHERE x.relation_id IN (?1,?2) AND x.child_turn_id<>d.child_turn_id AND x.status='success'", rusqlite::params![first,second], |r| r.get(0))?;
        if complete == 2 {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release("red-2");
    s.finish().await?;
    server.abort();
    Ok(())
}
