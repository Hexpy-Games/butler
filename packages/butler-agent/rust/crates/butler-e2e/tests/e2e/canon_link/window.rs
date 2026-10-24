use super::*;
use butler_canon::store::{runtime, runtime_context};
use rusqlite::{Connection, params};

fn pass(db: &mut Connection) -> Result<(), HarnessError> {
    let batch = runtime::prepare(db, 0).map_err(|e| HarnessError(e.to_string()))?;
    let tx = butler_canon::store::Transaction::new(db.transaction()?)
        .map_err(|e| HarnessError(e.to_string()))?;
    let result = runtime::catch_up(&tx, &runtime_context(1), &Default::default(), 0, batch)
        .map_err(|e| HarnessError(e.to_string()))?;
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    tx.commit()?;
    Ok(())
}
fn cursor(db: &Connection) -> Result<i64, HarnessError> {
    Ok(db.query_row(
        "SELECT value FROM canon_cursors WHERE name='link_reconcile'",
        [],
        |r| r.get(0),
    )?)
}

#[tokio::test]
async fn non_matching_rows_advance_exactly_one_bounded_window_per_signal()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-WINDOW")?.start().await?;
    s.agent.terminate().await?;
    let mut db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("DELETE FROM agent_task_graph_changes; DELETE FROM btcc_guided_tool_calls; DELETE FROM canon_cursors;")?;
    for row in 1..=769 {
        db.execute("INSERT INTO btcc_guided_tool_calls(rowid,call_id,turn_id,tool_name,raw_arguments,arguments_json,status,started_at) VALUES(?1,?2,'absent','read_file','{}','{}',?3,'now')",params![row,format!("unrelated-{row}"),if row % 2 == 0 {"started"} else {"awaiting_authority"}])?;
    }
    for end in [256, 512, 768, 769] {
        pass(&mut db)?;
        assert_eq!(cursor(&db)?, end, "one 256-row window per signal");
    }
    let writes = db.total_changes();
    pass(&mut db)?;
    assert_eq!(db.total_changes(), writes, "stationary cursor never writes");
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn crash_replayed_plan_stays_pending_until_completed_and_linked() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, script, server, id, chat) = setup("CB-PLAN-ORDER", false, false).await?;
    s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    s.agent.terminate().await?;
    let mut db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (turn,args,result): (String,String,String) = db.query_row("SELECT turn_id,arguments_json,result_json FROM btcc_guided_tool_calls WHERE tool_name='replace_work_plan' AND status='completed'",[],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    db.execute_batch("DELETE FROM canon_epic_work_links; DELETE FROM btcc_guided_tool_calls; DELETE FROM canon_cursors; DELETE FROM agent_task_graph_changes;")?;
    db.execute(
        "UPDATE btcc_turns SET semantic_state='admitted' WHERE turn_id=?1",
        [&turn],
    )?;
    for (row, status, arguments) in [
        (100, "started", args.as_str()),
        (101, "completed", "{}"),
        (102, "started", args.as_str()),
    ] {
        db.execute("INSERT INTO btcc_guided_tool_calls(rowid,call_id,turn_id,tool_name,raw_arguments,arguments_json,status,result_json,started_at) VALUES(?1,?2,?3,'replace_work_plan','{}',?4,?5,?6,'now')",params![row,format!("plan-{row}"),turn,arguments,status,if row==101 {"{\"ok\":false}"} else {result.as_str()}])?;
    }
    db.execute("INSERT INTO canon_cursors VALUES('link_reconcile',99)", [])?;
    pass(&mut db)?;
    assert_eq!(cursor(&db)?, 99, "X blocks even though Y is complete");
    db.execute(
        "UPDATE btcc_guided_tool_calls SET status='awaiting_authority' WHERE rowid=100",
        [],
    )?;
    pass(&mut db)?;
    assert_eq!(cursor(&db)?, 99, "authority wait also blocks");
    // X completes after Y; its separate post-commit link publication was lost.
    db.execute(
        "UPDATE btcc_guided_tool_calls SET status='completed' WHERE rowid=100",
        [],
    )?;
    pass(&mut db)?;
    assert_eq!(cursor(&db)?, 101);
    let linked: String = db.query_row("SELECT epic_id FROM canon_epic_work_links", [], |r| {
        r.get(0)
    })?;
    assert_eq!(linked, id, "reconcile repairs X's missing link");
    // Restart reconciliation runs before a recovered Turn takes over its claim.
    db.execute_batch("DELETE FROM btcc_state_claims; DELETE FROM canon_epic_work_links;")?;
    pass(&mut db)?;
    assert_eq!(cursor(&db)?, 101, "the admitted replay still blocks");
    db.execute(
        "UPDATE btcc_guided_tool_calls SET status='completed' WHERE rowid=102",
        [],
    )?;
    let session: String = db.query_row(
        "SELECT session_id FROM btcc_turns WHERE turn_id=?1",
        [&turn],
        |r| r.get(0),
    )?;
    // The replay commits its result, but the separate link transaction fails.
    db.execute_batch("CREATE TRIGGER fail_link BEFORE INSERT ON canon_epic_work_links BEGIN SELECT RAISE(ABORT,'link write failed'); END;")?;
    {
        let tx = butler_canon::store::Transaction::new(db.transaction()?)
            .map_err(|e| HarnessError(e.to_string()))?;
        let result: Value = serde_json::from_str(&result)?;
        let result = result.get("output").unwrap_or(&result);
        let error = runtime::link(
            &tx,
            &runtime_context(1),
            &session,
            result["work"]["work_id"].as_str().unwrap(),
            &[format!("canon:epic/{id}")],
        )
        .unwrap_err();
        assert!(error.to_string().contains("link write failed"), "{error}");
    }
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epic_work_links", [], |r| r
            .get(0))?,
        0
    );
    db.execute_batch("DROP TRIGGER fail_link")?;
    pass(&mut db)?;
    assert_eq!(cursor(&db)?, 102);
    let linked: String = db.query_row("SELECT epic_id FROM canon_epic_work_links", [], |r| {
        r.get(0)
    })?;
    assert_eq!(
        linked, id,
        "reconcile repairs the crash-replayed call's link"
    );
    drop(db);
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn terminal_or_missing_turns_do_not_block_unfinished_plan_calls() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("CB-FINAL-PLAN")?.start().await?;
    s.agent.terminate().await?;
    let mut db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES('turn','own','inbox','key','message','input','snapshot','{}','{}','admitted',1,1);")?;
    for state in [
        "admitted",
        "delivery_committed",
        "cancelled",
        "delivered",
        "missing",
    ] {
        db.execute(
            "UPDATE btcc_turns SET semantic_state=?1 WHERE turn_id='turn'",
            [if state == "missing" {
                "delivered"
            } else {
                state
            }],
        )?;
        for status in ["started", "awaiting_authority"] {
            db.execute_batch("DELETE FROM btcc_guided_tool_calls; DELETE FROM canon_cursors; INSERT INTO canon_cursors VALUES('link_reconcile',99);")?;
            db.execute("INSERT INTO btcc_guided_tool_calls(rowid,call_id,turn_id,tool_name,raw_arguments,arguments_json,status,started_at) VALUES(100,'unfinished',?1,'replace_work_plan','{}','{}',?2,'now')", params![if state == "missing" { "absent" } else { "turn" }, status])?;
            pass(&mut db)?;
            let blocked = matches!(state, "admitted" | "delivery_committed");
            assert_eq!(
                cursor(&db)?,
                if blocked { 99 } else { 100 },
                "{state}/{status}"
            );
            let after: String = db.query_row(
                "SELECT status FROM btcc_guided_tool_calls WHERE rowid=100",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(after, status, "canon never mutates BTCC journal state");
        }
    }
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn unchanged_turn_state_does_not_invalidate_canon_progress() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-TURN-INVALIDATION")?.start().await?;
    s.agent.terminate().await?;
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES('turn','own','inbox','key','message','input','snapshot','{}','{}','admitted',1,1)")?;
    let seq = || {
        db.query_row::<i64, _, _>(
            "SELECT seq FROM agent_task_graph_changes WHERE session_id='own'",
            [],
            |r| r.get(0),
        )
    };
    let before = seq()?;
    db.execute_batch(
        "UPDATE btcc_turns SET semantic_state='admitted',revision=revision+1 WHERE turn_id='turn'",
    )?;
    assert_eq!(seq()?, before, "same state creates no invalidation");
    db.execute_batch("UPDATE btcc_turns SET semantic_state='delivered' WHERE turn_id='turn'")?;
    assert!(seq()? > before, "real state changes still invalidate");
    drop(db);
    s.finish().await
}
