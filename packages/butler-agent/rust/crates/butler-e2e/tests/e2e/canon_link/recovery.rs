use super::*;
use rusqlite::Connection;

fn cursors(db: &Connection) -> Result<(i64, i64), HarnessError> {
    Ok((
        db.query_row(
            "SELECT COALESCE((SELECT value FROM canon_cursors WHERE name='link_reconcile'),0)",
            [],
            |r| r.get(0),
        )?,
        db.query_row(
            "SELECT COALESCE((SELECT value FROM canon_cursors WHERE name='progress_feed'),0)",
            [],
            |r| r.get(0),
        )?,
    ))
}
async fn next_epic(s: &Scenario, script: &stub::Script, chat: &str) -> Result<(), HarnessError> {
    script.epics.lock().unwrap().swap(0, 1);
    let other = script.epics.lock().unwrap()[0].clone();
    let after =
        s.gw.events_since(0)
            .await?
            .last()
            .and_then(|e| e["id"].as_u64())
            .unwrap_or(0);
    let events = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, after).await?;
    let turn = s.gw.say(chat, "Process the documentation epic").await?;
    s.gw.wait_terminal(
        chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    wait_label(s, &other, "in_review").await?;
    events
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.progress_changed" && e["payload"]["epic_id"] == other
        })
        .await?;
    assert_eq!(
        progress(s, &other).await?["counts"],
        json!({"completed":1,"total":1})
    );
    Ok(())
}

#[tokio::test]
async fn deleted_epic_link_is_quarantined_without_stopping_canon_events() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CB-QUARANTINE", false, false).await?;
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let before = cursors(&db)?;
    let bad_feed: i64 = db.query_row("SELECT MAX(seq) FROM agent_task_graph_changes", [], |r| {
        r.get(0)
    })?;
    db.pragma_update(None, "foreign_keys", false)?;
    // A newly completed plan needs reconciliation after its link was corrupted.
    // The held model prevents the next source signal until both writes commit.
    db.execute_batch("BEGIN IMMEDIATE")?;
    db.execute("INSERT INTO btcc_guided_tool_calls(call_id,turn_id,tool_name,raw_arguments,arguments_json,status,result_json,started_at,finished_at)
        SELECT 'lost-link',turn_id,tool_name,raw_arguments,arguments_json,status,result_json,started_at,finished_at FROM btcc_guided_tool_calls WHERE tool_name='replace_work_plan' AND status='completed' LIMIT 1",[])?;
    let bad_row = db.last_insert_rowid();
    db.execute(
        "UPDATE canon_epic_work_links SET epic_id='deleted-epic' WHERE epic_id=?1",
        [&id],
    )?;
    db.execute_batch("COMMIT")?;
    script.release();
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let after = cursors(&db)?;
        if after.0 > before.0 && after.0 >= bad_row && after.1 > before.1 && after.1 >= bad_feed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cursors {before:?} -> {after:?}; bad row {bad_row}, feed {bad_feed}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drop(db);
    next_epic(&s, &script, &chat).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn unreadable_project_work_keeps_canon_reads_and_other_epic_events_available()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CB-UNREADABLE", false, false).await?;
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    script.release();
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    wait_label(&s, &id, "in_review").await?;
    // Keep a second, readable Work ready before corrupting the first record.
    next_epic(&s, &script, &chat).await?;
    script.epics.lock().unwrap().swap(0, 1);
    let detail = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    let project = detail["project_id"].as_str().unwrap();
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (work,ledger): (String,String) = db.query_row("SELECT w.work_id,w.ledger_project_id FROM btcc_guided_works w JOIN canon_epic_work_links l ON l.btcc_work_id=w.work_id WHERE l.epic_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    // Invalid managed record, isolated to this one Work in the real Ledger path.
    let path = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(ledger)
        .join("work")
        .join(&work)
        .join("work.md");
    std::fs::write(path, "unreadable managed Work")?;
    let degraded = progress(&s, &id).await?;
    assert_eq!(degraded["actions"], json!([]));
    assert_eq!(degraded["disposition"], Value::Null);
    assert_eq!(
        degraded["stage"], "reporting",
        "BTCC history survives missing Ledger view"
    );
    assert_eq!(degraded["counts"], json!({"completed":0,"total":0}));
    for route in [
        format!("/projects/{project}/canon"),
        format!("/canon/epics/{id}"),
        format!("/projects/{project}/canon/sidebar"),
    ] {
        data(s.gw.get(&route).await?, 200);
    }
    db.execute(
        "UPDATE canon_epic_work_links SET reported_applied=0 WHERE epic_id=?1",
        [&id],
    )?;
    let after =
        s.gw.events_since(0)
            .await?
            .last()
            .and_then(|e| e["id"].as_u64())
            .unwrap_or(0);
    let events = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, after).await?;
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    next_epic(&s, &script, &chat).await?;
    events
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.progress_changed" && e["payload"]["epic_id"] == id
        })
        .await?;
    drop(events);
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
    let warnings = log
        .lines()
        .filter(|line| line.contains("Canon project Work read failed") && line.contains(&work))
        .count();
    assert_eq!(warnings, 1, "one warning until this Work becomes readable");
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
