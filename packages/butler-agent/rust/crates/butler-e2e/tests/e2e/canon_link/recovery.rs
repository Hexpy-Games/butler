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

#[tokio::test]
async fn moved_or_unreadable_project_work_keeps_project_chat_working() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CB-MOVED-LEDGER", false, false).await?;
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
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (ledger, session): (String, String) = db.query_row("SELECT w.ledger_project_id,w.session_id FROM btcc_guided_works w JOIN canon_epic_work_links l ON l.btcc_work_id=w.work_id WHERE l.epic_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    // The data folder moved: the stored Ledger roots name where it used to be.
    let root = s.sandbox.data.join("project-ledger/projects").join(&ledger);
    let roots = [std::fs::canonicalize(&root)?, root]
        .map(|path| serde_json::to_string(&path.to_string_lossy()).unwrap());
    let moved = serde_json::to_string(&format!("/moved-away/project-ledger/projects/{ledger}"))?;
    let mut rewritten = 0;
    for dir in ["occurrences", "receipts"] {
        let folder = s
            .sandbox
            .data
            .join("runtime/btcc-project-ledger-effects-v2")
            .join(dir);
        for entry in std::fs::read_dir(folder)? {
            let path = entry?.path();
            let text = std::fs::read_to_string(&path)?;
            let moved_text = roots
                .iter()
                .fold(text.clone(), |text, root| text.replace(root, &moved));
            if moved_text != text {
                std::fs::write(path, moved_text)?;
                rewritten += 1;
            }
        }
    }
    assert!(rewritten > 0, "stored Ledger roots name {roots:?}");
    next_epic(&s, &script, &chat).await?;
    script.epics.lock().unwrap().swap(0, 1);
    // The session's head Work becomes unreadable.
    let head: String = db.query_row(
        "SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id=?1",
        [&session],
        |r| r.get(0),
    )?;
    std::fs::write(
        s.sandbox
            .data
            .join("project-ledger/projects")
            .join(&ledger)
            .join("work")
            .join(&head)
            .join("work.md"),
        "unreadable managed Work",
    )?;
    next_epic(&s, &script, &chat).await?;
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
    assert!(
        log.lines().any(
            |line| line.contains("[project-work] unreadable Work skipped") && line.contains(&head)
        ),
        "the unreadable head is skipped and logged"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn pre_ledger_project_work_shows_its_own_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CB-PRE-LEDGER", false, false).await?;
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
    let before = progress(&s, &id).await?;
    assert_eq!(before["counts"], json!({"completed":1,"total":1}));
    let keys: Vec<Value> = before["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["actionKey"].clone())
        .collect();
    let plan: Vec<Value> = before["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| json!({"actionKey":a["actionKey"],"description":a["description"],"dependencyKeys":[]}))
        .collect();
    let states: Vec<Value> = keys
        .iter()
        .map(|k| json!({"actionKey":k,"status":"done"}))
        .collect();
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (work, origin, created): (String, String, String) = db.query_row("SELECT w.work_id,w.origin_turn_id,w.created_at FROM btcc_guided_works w JOIN canon_epic_work_links l ON l.btcc_work_id=w.work_id WHERE l.epic_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    db.execute("UPDATE btcc_guided_works SET ledger_project_id=NULL, canonical_head_sha256=NULL WHERE work_id=?1", [&work])?;
    db.execute("INSERT INTO btcc_guided_work_plan_revisions(plan_revision_id,work_id,revision,objective,governing_refs_json,execution_mode,actions_json,checks_json,origin_turn_id,created_at) VALUES('pre-ledger-plan',?1,1,'[]','[]','direct',?2,'[]',?3,?4)", rusqlite::params![work, serde_json::to_string(&plan)?, origin, created])?;
    db.execute("INSERT INTO btcc_guided_work_checkpoint_revisions(checkpoint_revision_id,work_id,revision,plan_revision_id,stage,public_summary,next_step,action_states_json,result_sequence,origin_turn_id,created_at) VALUES('pre-ledger-checkpoint',?1,1,'pre-ledger-plan','reporting','','',?2,0,?3,?4)", rusqlite::params![work, serde_json::to_string(&states)?, origin, created])?;
    let after = progress(&s, &id).await?;
    let n = keys.len();
    assert_eq!(after["counts"], json!({"completed":n,"total":n}));
    let after_keys: Vec<Value> = after["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["actionKey"].clone())
        .collect();
    assert_eq!(after_keys, keys);
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-1.log"))?;
    assert!(
        !log.lines()
            .any(|line| line.contains("Canon project Work read failed") && line.contains(&work)),
        "pre-Ledger Work reads from its BTCC rows"
    );
    data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
