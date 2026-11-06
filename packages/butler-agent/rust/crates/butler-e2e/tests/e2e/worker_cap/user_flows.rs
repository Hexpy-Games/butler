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

#[tokio::test]
async fn cb_11_result_turn_shows_running_task_and_names_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-RESULT-STATE", 2).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 2).await?;
    started(&script, 2).await;
    let task: String = {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        db.query_row(
            "SELECT task_id FROM btcc_work_tasks WHERE relation_id=?1",
            [rows[1]["relation"]["relation_id"].as_str().unwrap()],
            |row| row.get(0),
        )?
    };
    script.release("red-0");
    let deadline = Instant::now() + Duration::from_secs(30);
    let input = loop {
        let result = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(role, body)| {
                role == "steward" && body["input"].to_string().contains("Delegated result")
            })
            .map(|(_, body)| body["input"].to_string());
        if let Some(input) = result {
            break input;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(input.contains("Delegated actions: check-1 → "), "{input}");
    assert!(input.contains("Plan subjects (use these keys in task.scope.owns): batch = Batch"));
    let executable = input
        .split("\\n")
        .find(|line| line.starts_with("Executable action keys:"))
        .unwrap();
    assert!(!executable.contains("check-1"), "{executable}");
    assert!(input.contains("action_key: check-0"));
    assert!(input.contains(&format!("still running: {task} check-1 (active)")));
    assert!(input.contains("Workers you assign can call: "));
    assert!(input.contains("Choose the helper by the work. browse (the browsing agent)"));
    script.release("red-1");
    for row in &rows {
        closed(&s, row["session_id"].as_str().unwrap()).await?;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_11_later_result_turn_shows_earlier_worker_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-EARLIER-RESULT", 2).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 2).await?;
    started(&script, 2).await;
    script.release("red-0");
    let deadline = Instant::now() + Duration::from_secs(30);
    let first = loop {
        let found = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(role, body)| {
                let input = body["input"].to_string();
                role == "steward"
                    && input.contains("action_key: check-0")
                    && input.contains("Delegated result")
            })
            .map(|(_, body)| body["input"].to_string());
        if let Some(input) = found {
            break input;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(
        !first.contains("Earlier Worker results in this Work"),
        "{first}"
    );
    script.release("red-1");
    for row in &rows {
        closed(&s, row["session_id"].as_str().unwrap()).await?;
    }
    let (r0, r1, t0): (String, String, String) = {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let result = |row: &Value| -> Result<String, HarnessError> {
            Ok(db.query_row(
                "SELECT result_id FROM btcc_steward_results WHERE relation_id=?1",
                [row["relation"]["relation_id"].as_str().unwrap()],
                |r| r.get(0),
            )?)
        };
        let t0 = db.query_row(
            "SELECT task_id FROM btcc_work_tasks WHERE relation_id=?1",
            [rows[0]["relation"]["relation_id"].as_str().unwrap()],
            |r| r.get(0),
        )?;
        (result(&rows[0])?, result(&rows[1])?, t0)
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let second = loop {
        let found = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(role, body)| {
                let input = body["input"].to_string();
                role == "steward"
                    && input.contains(&format!("result_id: {r1}"))
                    && input.contains("action_key: check-1")
            })
            .map(|(_, body)| body["input"].to_string());
        if let Some(input) = found {
            break input;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(
        second.contains("Earlier Worker results in this Work (delivered to earlier turns):"),
        "{second}"
    );
    assert!(
        second.contains(&format!(
            "- result_id: {r0} task: {t0} action_key: check-0 (done)"
        )),
        "{second}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
