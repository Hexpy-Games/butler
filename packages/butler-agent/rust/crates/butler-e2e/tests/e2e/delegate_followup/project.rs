//! Project Work continuation must feed plan errors back and settle the child turn.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn blocked_project_followup_rejected_plan_reaches_terminal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false).await?;
    script.blocked.store(true, Ordering::SeqCst);
    script.routed.store(true, Ordering::SeqCst);
    script.hold_revision.store(true, Ordering::SeqCst);
    let s = Setup::new("PROJECT-FOLLOWUP-PLAN-REJECTION")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Source verification"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{project:?}");
    let parent = s.gw.post("/sessions", json!({"kind":"project","title":"Verification","project_id":project.data()["project"]["id"]})).await?;
    assert_eq!(parent.status, 201, "{parent:?}");
    let parent = parent.data()["session"]["id"].as_str().unwrap();
    s.turn(parent, stub::OWNER).await?;
    let first = wait_project_result(&s, parent, None).await?;
    assert_eq!(first["result"]["status"], "blocked", "{first}");
    let work_id = script.work.lock().unwrap().clone();
    let relation = first["relation"]["relation_id"].as_str().unwrap();
    let before = native_snapshot(&s, relation);
    assert_eq!(before["task_status"], "blocked");
    *script.relation.lock().unwrap() = relation.into();
    let (_, turn) = s.turn(parent, stub::FOLLOWUP).await?;
    assert_eq!(turn["state"], "delivered");
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .expect("the rejected correction must remain inspectable before the next apply");
    let rejected = native_snapshot(&s, relation);
    assert_eq!(rejected["task_id"], before["task_id"]);
    assert_eq!(rejected["task_status"], "running");
    assert_eq!(rejected["spec_ref"], before["spec_ref"]);
    assert_eq!(rejected["bodies"], before["bodies"]);
    assert_eq!(rejected["part_title"], before["part_title"]);
    assert_eq!(rejected["first_delivery"], before["first_delivery"]);
    assert_eq!(rejected["rejected_edits"], 1);
    script.release.notify_one();
    let second = wait_project_result(&s, parent, Some(&first)).await?;
    assert_eq!(second["session_id"], first["session_id"]);
    assert_eq!(second["result"]["status"], "success", "{second}");
    assert_terminal(&s, &second).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let settled = native_snapshot(&s, relation);
        assert_eq!(settled["first_delivery"], before["first_delivery"]);
        assert_eq!(settled["bodies"], before["bodies"]);
        if settled["task_status"] == "completed" && !settled["reported"].is_null() {
            assert_eq!(settled["child_attempts"], 2);
            break;
        }
        assert!(Instant::now() < deadline, "{settled}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let layout = s.gw.get(&format!("/works/{work_id}/tasks")).await?;
    assert_eq!(layout.status, 200, "{layout:?}");
    assert_eq!(layout.data()["chains"].as_array().unwrap().len(), 1);
    let requests = script.requests.lock().unwrap().clone();
    let messages: Vec<_> = requests
        .iter()
        .filter(|body| {
            butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default())
                .user_request
                .starts_with(stub::MESSAGE)
        })
        .collect();
    assert_eq!(messages.len(), 6, "{messages:?}\n{}", s.agent.logs());
    assert!(messages[3].to_string().contains("task_running_pinned"));
    assert!(
        !s.agent.logs().contains("Turn interrupted"),
        "{}",
        s.agent.logs()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn native_snapshot(s: &Scenario, relation: &str) -> Value {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let mut row:Value=db.query_row("SELECT t.id,t.status,t.spec_ref,t.result_reported_at,p.title FROM btcc_session_relations r JOIN wm_session_exec e ON e.session_id=r.child_session_id JOIN wm_tasks t ON t.id=e.current_task_id JOIN wm_task_parts p ON p.task_id=t.id AND p.assignee_session_id=r.child_session_id WHERE r.relation_id=?1",[relation],|r|Ok(json!({
        "task_id":r.get::<_,String>(0)?,"task_status":r.get::<_,String>(1)?,"spec_ref":r.get::<_,String>(2)?,"reported":r.get::<_,Option<i64>>(3)?,"part_title":r.get::<_,String>(4)?}))).unwrap();
    let mut stmt=db.prepare("SELECT hash,hex(body) FROM wm_spec_bodies WHERE hash IN (SELECT body_hash FROM wm_spec_revisions) ORDER BY hash").unwrap();
    row["bodies"] = json!(
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    );
    row["first_delivery"]=json!(db.query_row("SELECT input_json FROM btcc_subsession_outbox WHERE relation_id=?1 ORDER BY created_at,result_id LIMIT 1",[relation],|r|r.get::<_,String>(0)).unwrap());
    row["child_attempts"]=json!(db.query_row("SELECT count(*) FROM btcc_session_relations r JOIN wm_session_exec e ON e.session_id=r.child_session_id JOIN wm_attempts a ON a.task_id=e.current_task_id AND a.session_id=r.child_session_id WHERE r.relation_id=?1",[relation],|r|r.get::<_,i64>(0)).unwrap());
    row["rejected_edits"]=json!(db.query_row("SELECT count(*) FROM wm_audit WHERE entity_kind='work_apply' AND json_extract(payload_json,'$.response.error.code')='task_running_pinned'",[],|r|r.get::<_,i64>(0)).unwrap());
    row
}

async fn wait_project_result(
    s: &Scenario,
    parent: &str,
    previous: Option<&Value>,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={parent}"))
                .await?;
        let children = view.data()["steward_children"].as_array().unwrap();
        if let Some(child) = children.first()
            && child["result"].is_object()
            && previous.is_none_or(|prior| {
                prior["result"]["child_turn_id"] != child["result"]["child_turn_id"]
            })
        {
            return Ok(child.clone());
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn assert_terminal(s: &Scenario, child: &Value) -> Result<(), HarnessError> {
    let session = child["session_id"].as_str().unwrap();
    let turn = child["result"]["child_turn_id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={session}"))
                .await?;
        assert_eq!(view.status, 200, "{view:?}");
        let latest = &view.data()["latest_turn"];
        if latest["id"] == turn && latest["state"] == "delivered" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child turn did not settle: {view:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let state: String = db
        .query_row(
            "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
            [turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "delivered", "child turn must leave admitted state");
    Ok(())
}
