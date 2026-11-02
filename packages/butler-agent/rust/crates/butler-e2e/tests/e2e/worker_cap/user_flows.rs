//! Repeat a delegation, then cancel its running Worker and admit the next one.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn cb_11_repeat_delegation_then_cancel_acknowledges_and_advances_fifo()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-REPEAT-CANCEL", 4).await?;
    script.repeat_first.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    workers(&s, "general", 3).await?;
    started(&script, 2).await;
    {
        let outputs = script.repeated_outputs.lock().unwrap();
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0]["ok"], true);
        assert_eq!(outputs[1]["error"]["code"], "already_delegated");
        assert_eq!(outputs[1]["wait_for_child"], true);
        for key in ["relation_id", "child_session_id"] {
            assert!(outputs[0][key].is_string(), "{outputs:?}");
            assert_eq!(outputs[0][key], outputs[1][key]);
        }
    }
    script.fourth.add_permits(1);
    let (parent, rows) = workers(&s, "general", 4).await?;
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1"]);
    assert_eq!(rows[2]["status"], "waiting");
    assert_eq!(rows[3]["status"], "waiting");
    let relation = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/steward-relations/{relation}/cancel"),
            json!({"parent_session_id":parent}),
        )
        .await?;
    assert_eq!(response.status, 202, "{response:?}");
    assert_eq!(response.data()["status"], "cancelling");
    assert_eq!(
        response.data()["child_turn_id"],
        rows[0]["latest_turn"]["id"]
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let acknowledged: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_steward_results x USING(relation_id) JOIN btcc_subsession_outbox o USING(result_id) JOIN btcc_guided_works w ON w.work_id=d.root_work_id WHERE d.relation_id=?1 AND d.dispatch_state IS NULL AND x.child_turn_id=d.child_turn_id AND x.status='cancelled' AND o.status='delivered' AND w.status='abandoned')",
            [relation], |r| r.get(0))?;
        if acknowledged {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    started(&script, 3).await;
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1", "red-2"]);
    let (_, current) = workers(&s, "general", 4).await?;
    assert_eq!(current[3]["status"], "waiting");
    script.release("red-0");
    script.release("red-1");
    started(&script, 4).await;
    script.release("red-2");
    script.release("red-3");
    for row in &rows[1..] {
        closed(&s, row["session_id"].as_str().unwrap()).await?;
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for row in &rows {
        let counts: (u64, u64) = db.query_row(
            "SELECT (SELECT count(*) FROM btcc_turns WHERE session_id=?1), (SELECT count(*) FROM btcc_steward_results WHERE relation_id=?2)",
            rusqlite::params![row["session_id"].as_str().unwrap(), row["relation"]["relation_id"].as_str().unwrap()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert_eq!(counts, (1, 1), "one turn and result per Worker: {row}");
    }
    drop(db);
    assert_eq!(
        *script.started.lock().unwrap(),
        ["red-0", "red-1", "red-2", "red-3"]
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
