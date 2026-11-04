//! Worker failures and cancellation through the real provider and durable queue.
use super::*;
use std::sync::atomic::Ordering;

/// A settled Worker turn keeps a direction for the turn that can act on it.
#[tokio::test]
async fn cb_11_direction_during_a_workers_final_report_opens_its_own_turn()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-WORKER-REPORT", 3).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    script.hold_worker_report.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.release("red-0");
    tokio::time::timeout(Duration::from_secs(30), script.worker_reporting.wait())
        .await
        .expect("the Worker reached its final report");
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_pending_direction(&s, &rows[0])?;
    script.worker_report_release.add_permits(1);
    script.release("red-1");
    tokio::time::timeout(Duration::from_secs(30), script.continued.wait())
        .await
        .expect("the direction opened its own Worker turn");
    let relation = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let database = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let applied: String = loop {
        use rusqlite::OptionalExtension;
        let applied = database
            .query_row(
                "SELECT applied_child_turn_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='applied'",
                [relation],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(applied) = applied {
            break applied;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(
        applied.starts_with("subsession-direction-turn-"),
        "the settled turn swallowed the direction: {applied}"
    );
    script.release("red-2");
    s.finish().await?;
    server.abort();
    Ok(())
}

fn steward_results(
    db: &rusqlite::Connection,
    session: &str,
) -> Result<Vec<(String, String)>, rusqlite::Error> {
    db.prepare("SELECT child_turn_id,status FROM btcc_steward_results WHERE child_session_id=?1 ORDER BY rowid")?
        .query_map([session], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

fn relation_status(
    db: &rusqlite::Connection,
    table: &str,
    relation: &str,
) -> Result<Option<String>, rusqlite::Error> {
    use rusqlite::OptionalExtension;
    db.query_row(
        &format!("SELECT status FROM {table} WHERE relation_id=?1"),
        [relation],
        |row| row.get(0),
    )
    .optional()
}

/// Closing a Steward's Work ends its running Worker; the Worker's late result
/// reopens nothing and cannot replace the Steward's result.
#[tokio::test]
async fn cb_11_closing_steward_work_cancels_its_running_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-LATE-WORKER", 1).await?;
    script.close_before_worker.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (steward, rows) = workers(&s, "general", 1).await?;
    started(&script, 1).await;
    let database = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while steward_results(&database, &steward)?.is_empty() {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        steward_results(&database, &steward)?[0].1,
        "success",
        "{:?}",
        steward_results(&database, &steward)?
    );
    let worker = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while relation_status(&database, "btcc_steward_results", worker)?.as_deref()
        != Some("cancelled")
    {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while relation_status(&database, "btcc_subsession_outbox", worker)?.as_deref()
        != Some("delivered")
    {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release("red-0");
    assert_eq!(
        steward_results(&database, &steward)?.len(),
        1,
        "a late Worker result cannot replace the Steward's result"
    );
    closed(&s, &steward).await?;
    let works: i64 = database.query_row(
        "SELECT count(*) FROM btcc_guided_works WHERE session_id=?1",
        [&steward],
        |row| row.get(0),
    )?;
    assert_eq!(works, 1, "a late Worker result starts no Work");
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A Worker result already queued when its Steward closes the Work settles
/// without a Steward turn; the card keeps the delivered result.
#[tokio::test]
async fn cb_11_worker_result_queued_before_the_steward_closes_starts_no_turn()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-QUEUED-LATE-WORKER", 1).await?;
    script.close_before_worker.store(true, Ordering::SeqCst);
    script.hold_steward_close.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (steward, rows) = workers(&s, "general", 1).await?;
    started(&script, 1).await;
    tokio::time::timeout(Duration::from_secs(30), script.steward_closing.wait())
        .await
        .expect("the Steward reached its closeout");
    script.release("red-0");
    let database = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let worker = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while relation_status(&database, "btcc_subsession_outbox", worker)?.as_deref()
        != Some("delivered")
    {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.steward_close_release.add_permits(1);
    closed(&s, &steward).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let processed = super::super::steward_interrupted_queue::records(
            &s.sandbox.data.join("runtime/inbound-events"),
            "processed",
        )
        .into_iter()
        .any(|path| {
            let record = super::super::steward_interrupted_queue::read_record(&path);
            record
                .pointer("/envelope/raw/source")
                .and_then(Value::as_str)
                == Some("btcc-worker-result")
                && record.pointer("/envelope/peer/id").and_then(Value::as_str)
                    == Some(steward.as_str())
        });
        if processed {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let results = steward_results(&database, &steward)?;
    assert_eq!(results.len(), 1, "{results:?}");
    assert_eq!(results[0].1, "success", "{results:?}");
    let works: i64 = database.query_row(
        "SELECT count(*) FROM btcc_guided_works WHERE session_id=?1",
        [&steward],
        |row| row.get(0),
    )?;
    assert_eq!(works, 1, "a late Worker result starts no Work");
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(
        view.data()["steward_children"][0]["result"]["status"],
        "success"
    );
    assert!(view.data()["steward_children"][0]["active_turn"].is_null());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_11_cancel_finished_workers_waiting_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    cancel_continuation(false).await
}

#[tokio::test]
async fn cb_11_cancel_finished_workers_running_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    cancel_continuation(true).await
}

async fn cancel_continuation(running: bool) -> Result<(), HarnessError> {
    let (mut s, script, server) = setup("CB-11-CANCEL-CONTINUATION", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    script.hold_continuation.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (parent, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    started(&script, 3).await;
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_pending_direction(&s, &rows[0])?;
    if running {
        script.release("red-1");
        tokio::time::timeout(Duration::from_secs(30), script.continued.wait())
            .await
            .unwrap();
    }
    script.fourth.add_permits(1);
    let (_, all) = workers(&s, "general", 4).await?;
    assert_eq!(all[3]["status"], "waiting");
    assert_eq!(script.started.lock().unwrap().len(), 3);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: u64 = db.query_row(
        butler_turn::btcc::storage::RUNNING_WORKERS_SQL,
        [&parent],
        |r| r.get(0),
    )?;
    assert_eq!(
        count, 2,
        "live continuations must count after their direction is consumed"
    );
    drop(db);
    let relation = rows[0]["relation"]["relation_id"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/steward-relations/{relation}/cancel"),
            json!({"parent_session_id":parent}),
        )
        .await?;
    assert_eq!(response.status, 202, "{response:?}");
    let cancelled_turn = response.data()["child_turn_id"].as_str().unwrap();
    script.continuation_release.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let cleared: bool = db.query_row("SELECT dispatch_state IS NULL AND EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id AND x.child_turn_id=?2 AND x.status='cancelled') AND NOT EXISTS (SELECT 1 FROM btcc_subsession_directions i WHERE i.relation_id=d.relation_id AND i.status='pending') FROM btcc_subsession_delegations d WHERE relation_id=?1", rusqlite::params![relation,cancelled_turn], |r| r.get(0))?;
        if cleared {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cancel did not settle continuation: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !running {
        script.release("red-1");
    }
    started(&script, 4).await;
    script.release("red-2");
    script.release("red-3");
    let (_, all) = workers(&s, "general", 4).await?;
    closed(&s, all[3]["session_id"].as_str().unwrap()).await?;
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let pending: u64 = db.query_row(
        "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
        [relation],
        |r| r.get(0),
    )?;
    assert_eq!(pending, 0);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_11_missing_dispatch_intent_closes_and_fifo_moves_on() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unpublishable(false).await
}

#[tokio::test]
async fn cb_11_undecodable_dispatch_closes_and_fifo_moves_on() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unpublishable(true).await
}

async fn unpublishable(undecodable: bool) -> Result<(), HarnessError> {
    let (s, script, server) = setup("CB-11-INVALID-DISPATCH", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.fourth.add_permits(1);
    let (_, rows) = workers(&s, "general", 4).await?;
    let relation = rows[2]["relation"]["relation_id"].as_str().unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        if undecodable {
            "UPDATE btcc_subsession_delegations SET packet_json='{}' WHERE relation_id=?1"
        } else {
            "UPDATE btcc_subsession_delegations SET dispatch_intent_json=NULL WHERE relation_id=?1"
        },
        [relation],
    )?;
    script.release("red-0");
    started(&script, 3).await;
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1", "red-3"]);
    let state: (Option<String>, String) = db.query_row("SELECT d.dispatch_state,x.status FROM btcc_subsession_delegations d JOIN btcc_steward_results x USING(relation_id) WHERE d.relation_id=?1", [relation], |r| Ok((r.get(0)?,r.get(1)?)))?;
    assert_eq!(state, (None, "failed".into()));
    script.release("red-1");
    script.release("red-3");
    closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
