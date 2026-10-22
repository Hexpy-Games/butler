//! WMU-03/09/11 run through the scripted provider and ordinary gateway.
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

async fn start_mode(
    id: &str,
    hold_report: bool,
    use_worker: bool,
) -> Result<
    (
        Scenario,
        Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        Value,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    script.hold_report.store(hold_report, Ordering::SeqCst);
    script.use_worker.store(use_worker, Ordering::SeqCst);
    let s = Setup::new(id)?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    s.turn("general", stub::FEATURE).await?;
    tokio::time::timeout(Duration::from_secs(20), script.child_held.notified())
        .await
        .expect("assigned child reached its effect boundary");
    let assigned=super::database(&s,|db|db.query_row("SELECT a.session_id,a.task_id,a.id,a.turn_id,t.work_id,p.id FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id JOIN wm_task_parts p ON p.id=a.part_id WHERE a.status='running' AND a.part_id IS NOT NULL",[],|r|Ok(json!({
        "session":r.get::<_,String>(0)?,"task":r.get::<_,String>(1)?,"attempt":r.get::<_,String>(2)?,"turn":r.get::<_,String>(3)?,"work":r.get::<_,String>(4)?,"part":r.get::<_,String>(5)?})))).await?;
    *script.target.lock().unwrap() = assigned["session"].as_str().unwrap().into();
    Ok((s, script, server, assigned))
}

async fn start(
    id: &str,
    hold_report: bool,
) -> Result<
    (
        Scenario,
        Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        Value,
    ),
    HarnessError,
> {
    start_mode(id, hold_report, false).await
}

async fn control_receipt(s: &Scenario, turn: &Value) -> Result<Value, HarnessError> {
    let turn = turn["id"].as_str().unwrap().to_owned();
    let raw=super::database(s,move |db|db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='session_control' ORDER BY rowid DESC LIMIT 1",[turn],|r|r.get::<_,String>(0))).await?;
    Ok(serde_json::from_str(&raw)?)
}

async fn task(s: &Scenario, id: &Value) -> Result<Value, HarnessError> {
    let id = id.as_str().unwrap().to_owned();
    super::database(s,move |db|db.query_row("SELECT status,result_reported_at,spec_ref,revision FROM wm_tasks WHERE id=?1",[id],|r|Ok(json!({
        "status":r.get::<_,String>(0)?,"reported":r.get::<_,Option<i64>>(1)?,"spec_ref":r.get::<_,String>(2)?,"revision":r.get::<_,i64>(3)?})))).await
}

async fn wait_completed(s: &Scenario, id: &Value) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let row = task(s, id).await?;
        if row["status"] == "completed" && !row["reported"].is_null() {
            return Ok(row);
        }
        assert!(Instant::now() < deadline, "{row}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn wmu_03_09_child_lease_steer_and_reporting_precede_queued_followup()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-03-09", true).await?;
    let (_, steer) = s.turn("general", stub::STEER).await?;
    let receipt = control_receipt(&s, &steer).await?;
    assert_eq!(receipt["ok"], true, "{receipt}");
    assert_eq!(receipt["control_epoch"], 1);
    let queued=s.gw.post("/session-queue",json!({"chat_id":"general","text":stub::QUEUED,"client_message_id":"after-delegated-result"})).await?;
    assert_eq!(queued.status, 202, "{queued:?}");
    script.release_child.notify_one();
    tokio::time::timeout(Duration::from_secs(30), script.report_held.notified())
        .await
        .expect("parent reviewed the delegated result before reporting");
    let row = task(&s, &assigned["task"]).await?;
    assert_eq!(row["status"], "completed", "{row}");
    assert!(
        row["reported"].is_null(),
        "reporting cannot precede the delivering answer"
    );
    let child = assigned["session"].as_str().unwrap().to_owned();
    let state=super::database(&s,move |db|db.query_row("SELECT a.status,p.assignee_session_id,p.status FROM wm_attempts a JOIN wm_task_parts p ON p.id=a.part_id WHERE a.session_id=?1",[child],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))).await?;
    assert_eq!(
        state,
        (
            "succeeded".into(),
            assigned["session"].as_str().unwrap().into(),
            "completed".into()
        )
    );
    assert_eq!(
        tokio::fs::read_to_string(s.sandbox.data.join("feature-marker.txt")).await?,
        "corrected marker"
    );
    let requests = script.requests.lock().unwrap().clone();
    for body in requests.iter().filter(|body| {
        native_request(body) == stub::FEATURE
            && !super::super::work_model_script::outputs(body).is_empty()
    }) {
        let instructions = body["instructions"].as_str().unwrap();
        assert!(instructions.contains(butler_work::store::TIER_TWO));
        assert!(!instructions.contains(butler_work::store::TIER_ONE));
    }
    assert!(!requests.iter().any(|body| {
        butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default()).user_request
            == stub::QUEUED
    }));
    let instruction = receipt["instruction_id"].as_str().unwrap().to_owned();
    assert_eq!(
        super::database(&s, move |db| db.query_row(
            "SELECT status FROM wm_instructions WHERE id=?1",
            [instruction],
            |r| r.get::<_, String>(0)
        ))
        .await?,
        "applied"
    );
    script.release_report.notify_one();
    wait_completed(&s, &assigned["task"]).await?;
    wait_message(&s, stub::QUEUED_REPLY).await?;
    let messages = s.gw.messages("general").await?;
    let position = |text| {
        messages
            .iter()
            .position(|message| message["text"] == text)
            .unwrap()
    };
    assert!(
        position(stub::RESULT) < position(stub::QUEUED_REPLY),
        "{messages:?}"
    );
    assert_eq!(
        super::database(&s, |db| db.query_row(
            "SELECT count(*) FROM wm_works",
            [],
            |r| r.get::<_, i64>(0)
        ))
        .await?,
        1,
        "no child root Work"
    );
    let layout =
        s.gw.get(&format!(
            "/works/{}/tasks",
            assigned["work"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(layout.status, 200, "{layout:?}");
    assert_eq!(
        layout.data()["chains"][0]["steps"][0]["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn wmu_03_parent_stop_is_cas_bound_and_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-03-STOP", false).await?;
    let (_, steer) = s.turn("general", stub::STEER).await?;
    assert_eq!(control_receipt(&s, &steer).await?["control_epoch"], 1);
    let (_, stop) = s.turn("general", stub::STOP).await?;
    let first = control_receipt(&s, &stop).await?;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["control_epoch"], 2);
    script.release_child.notify_one();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        if view.data()["steward_children"][0]["status"] == "cancelled" {
            break;
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (_, stop) = s.turn("general", stub::STOP).await?;
    assert_eq!(
        control_receipt(&s, &stop).await?,
        first,
        "retry replays the same control receipt"
    );
    let counts=super::database(&s,|db|db.query_row("SELECT (SELECT count(*) FROM wm_holds WHERE kind='stop'),(SELECT count(*) FROM btcc_subsession_outbox)",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?)))).await?;
    assert_eq!(counts, (1, 1));
    let row = task(&s, &assigned["task"]).await?;
    assert_eq!(row["status"], "blocked");
    assert!(row["reported"].is_null());
    assert!(!s.sandbox.data.join("feature-marker.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn wmu_11_approved_criterion_edit_fences_active_effects_and_keeps_completed_tasks()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-11", false).await?;
    script.release_child.notify_one();
    let completed = wait_completed(&s, &assigned["task"]).await?;
    s.turn("general", stub::SECOND).await?;
    s.turn("general", stub::EDIT).await?;
    assert_eq!(
        task(&s, &assigned["task"]).await?,
        completed,
        "completed history remains exact"
    );
    let states = super::database(&s, |db| {
        let mut stmt = db.prepare(
            "SELECT status,step_index,spec_ref FROM wm_tasks ORDER BY step_index,stack_position",
        )?;
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await?;
    assert_eq!(
        states.len(),
        4,
        "two bound outcomes each have a corrective Task: {states:?}"
    );
    assert_eq!(states.iter().filter(|row| row.0 == "completed").count(), 1);
    assert_eq!(states.iter().filter(|row| row.0 == "blocked").count(), 1);
    assert_eq!(
        states.iter().map(|row| row.1).collect::<Vec<_>>(),
        vec![0, 1, 1, 2]
    );
    assert!(!s.sandbox.data.join("stale-effect.txt").exists());
    let requests = script.requests.lock().unwrap().clone();
    let last = requests
        .iter()
        .rev()
        .find(|body| {
            butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default())
                .user_request
                == stub::EDIT
        })
        .unwrap();
    let outputs = super::super::work_model_script::outputs(last);
    assert_eq!(outputs[3]["ok"], true, "{outputs:?}");
    assert_eq!(outputs[4]["error"]["code"], "task_not_started");
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_message(s: &Scenario, text: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if s.gw
            .messages("general")
            .await?
            .iter()
            .any(|message| message["text"] == text && message["status"] == "delivered")
        {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "message missing: {text}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn delivered_child_result_can_be_reviewed_in_a_later_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-LATER-REVIEW", false).await?;
    script.defer_review.store(true, Ordering::SeqCst);
    script.release_child.notify_one();
    wait_message(&s, stub::DEFERRED).await?;
    s.turn("general", stub::LATER).await?;
    let row = task(&s, &assigned["task"]).await?;
    assert_eq!(row["status"], "completed", "{row}");
    assert!(
        !row["reported"].is_null(),
        "delivered result must release its following step: {row}"
    );
    s.turn("general", stub::QUEUED).await?;
    wait_message(&s, stub::QUEUED_REPLY).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn paused_child_allows_parent_queue_and_resume_releases_hold() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-PAUSE-RESUME", false).await?;
    let (_, turn) = s.turn("general", stub::PAUSE).await?;
    let receipt = control_receipt(&s, &turn).await?;
    assert_eq!(receipt["ok"], true, "{receipt}");
    *script.hold.lock().unwrap() = receipt["hold_id"].as_str().unwrap().into();
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general","text":stub::QUEUED,"client_message_id":"paused-followup"}),
        )
        .await?;
    assert_eq!(queued.status, 202);
    wait_message(&s, stub::QUEUED_REPLY).await?;
    let (_, turn) = s.turn("general", stub::RESUME).await?;
    assert_eq!(control_receipt(&s, &turn).await?["ok"], true);
    script.release_child.notify_one();
    wait_completed(&s, &assigned["task"]).await?;
    let active = super::database(&s, |db| {
        db.query_row(
            "SELECT count(*) FROM wm_holds WHERE released_at IS NULL",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .await?;
    assert_eq!(active, 0);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn legacy_cancel_then_steer_releases_stop_and_continues_child() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-LEGACY-RESUME", false).await?;
    s.turn("general", stub::LEGACY_STOP).await?;
    let receipt=super::database(&s,|db|db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='cancel_steward' ORDER BY rowid DESC LIMIT 1",[],|r|r.get::<_,String>(0))).await?;
    let receipt: Value = serde_json::from_str(&receipt)?;
    assert!(receipt["hold_id"].is_string(), "{receipt}");
    *script.relation.lock().unwrap() = receipt["relation_id"].as_str().unwrap().to_owned();
    script.release_child.notify_one();
    wait_message(
        &s,
        "The delegated work was stopped; its Task remains resumable.",
    )
    .await?;
    s.turn("general", stub::LEGACY_RESUME).await?;
    wait_completed(&s, &assigned["task"]).await?;
    assert_eq!(
        tokio::fs::read_to_string(s.sandbox.data.join("feature-marker.txt")).await?,
        "corrected marker"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn invalid_session_control_is_a_model_fixable_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start("WMU-CONTROL-ERROR", false).await?;
    for request in [stub::INVALID, stub::STALE, stub::MISSING] {
        if request == stub::MISSING {
            super::database(&s,|db|db.execute("DELETE FROM wm_session_exec WHERE session_id IN (SELECT parent_session_id FROM btcc_session_relations)",[])).await?;
        }
        let (_, turn) = s.turn("general", request).await?;
        let receipt = control_receipt(&s, &turn).await?;
        assert_eq!(receipt["ok"], false, "{receipt}");
        assert_eq!(
            receipt["error"]["code"],
            if request == stub::STALE {
                "conflict"
            } else {
                "work_apply_rejected"
            },
            "{receipt}"
        );
    }
    script.release_child.notify_one();
    wait_completed(&s, &assigned["task"]).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

fn native_request(body: &Value) -> String {
    butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default()).user_request
}

#[tokio::test]
async fn worker_queue_result_reports_when_the_steward_turn_ends() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, assigned) = start_mode("WMU-WORKER-REPORT", false, true).await?;
    script.release_child.notify_one();
    wait_completed(&s, &assigned["task"]).await?;
    let reports=super::database(&s,|db|db.query_row("SELECT count(*),sum(delivered_at IS NOT NULL AND delivery_ended_at IS NOT NULL) FROM wm_delegation_reports",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?)))).await?;
    assert_eq!(reports, (2, 2));
    assert_eq!(
        tokio::fs::read_to_string(s.sandbox.data.join("feature-marker.txt")).await?,
        "corrected marker"
    );
    s.turn("general", stub::QUEUED).await?;
    wait_message(&s, stub::QUEUED_REPLY).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
