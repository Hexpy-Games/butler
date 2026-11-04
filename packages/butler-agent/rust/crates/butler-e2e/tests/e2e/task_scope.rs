//! TSK: real durable Work and delegation services with an offline child queue.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod lifecycle;
mod writes;
use butler_e2e::e2e::task_graph::{GraphBuilder, GraphWork};
use butler_turn::btcc::*;
use serde_json::{Value, json};
use std::path::Path;

type Result<T = ()> = std::result::Result<T, butler_e2e::e2e::task_graph::Error>;
async fn setup(path: &Path) -> Result<(GraphBuilder, GraphWork)> {
    let mut b = GraphBuilder::open(path).await?;
    b.access_mode = Some(AccessMode::FullAccess);
    let mut w = b.graph("task-owner", 1, "Partition work").await?;
    w.view=b.work.replace_plan(serde_json::from_value(json!({
        "turnId":w.scope.turn_id,"sessionId":w.scope.session_id,"mutationCallId":"subjects",
        "objective":"Partition work","executionMode":"workers","subjects":[{"key":"item","label":"Item"}],
        "actions":[{"actionKey":"a","description":"Research","dependencyKeys":[]},{"actionKey":"b","description":"Integrate","dependencyKeys":[]}],"checks":["Complete results"]
    }))?).await?;
    b.review(&mut w, "plan", "accept", json!([])).await?;
    Ok((b, w))
}
fn task(aspect: &str) -> Value {
    json!({"scope":{"owns":[{"subject":"item","aspects":[aspect]}]},"output":{"format":"text","fields":["summary"]}})
}
fn request(w: &GraphWork, id: &str, task: Value) -> WorkerDelegationRequest {
    WorkerDelegationRequest {
        task: Some(serde_json::from_value(task).unwrap()),
        parent_session_id: w.scope.session_id.clone(),
        parent_turn_id: w.scope.turn_id.clone(),
        anchor_message_id: w.scope.turn_id.clone(),
        source_tool_call_id: id.into(),
        action_key: "a".into(),
        objective: id.into(),
        acceptance_criteria: vec!["Complete results".into()],
        implementation_brief: "Use inputs and report findings".into(),
        replaces_relation_id: None,
        safe_title: Some(id.into()),
        profile_id: None,
        access_mode: AccessMode::FullAccess,
        schedule_run: None,
    }
}
async fn assign(b: &GraphBuilder, w: &GraphWork, id: &str, task: Value) -> Result<Value> {
    Ok(b.children
        .delegate_worker(request(w, id, task), &w.view)
        .await?)
}
fn db(path: &Path) -> Result<rusqlite::Connection> {
    Ok(rusqlite::Connection::open(
        path.join("agent-runtime/btcc.sqlite"),
    )?)
}

#[tokio::test]
async fn tsk_03_wait_uses_durable_admission_after_completion() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-SCOPE")?;
    let (mut b, w) = setup(&dir.data).await?;
    let first = assign(&b, &w, "first", task("price")).await?;
    let worker = b
        .admit_child(
            first["child_session_id"].as_str().unwrap(),
            SessionRole::Worker,
        )
        .await?;
    let mut wait = task("price");
    wait["inputs"] = json!([{"task": first["task_id"], "use": "facts"}]);
    let waiting = assign(&b, &w, "later", wait).await?;
    assert_eq!(waiting["status"], "waiting", "{waiting}");
    let db = db(&dir.data)?;
    let status: String = db.query_row(
        "SELECT status FROM btcc_work_tasks WHERE task_id=?1",
        [waiting["task_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(status, "pending");
    b.close().await?;
    let mut b = GraphBuilder::open(&dir.data).await?;
    b.result(&worker, "success", "Confirmed complete findings")
        .await?;
    let status: String = db.query_row(
        "SELECT status FROM btcc_work_tasks WHERE task_id=?1",
        [waiting["task_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(status, "active");
    let tasks = b.children.repository().work_tasks(w.view.work_id).await?;
    assert_eq!(tasks[1].inputs.len(), 1);
    assert_eq!(tasks[1].inputs[0].task, first["task_id"].as_str().unwrap());
    let context:String=db.query_row("SELECT json_extract(packet_json,'$.task_context') FROM btcc_subsession_delegations WHERE relation_id=?1",[waiting["relation_id"].as_str().unwrap()],|r|r.get(0))?;
    assert!(context.contains("Confirmed complete findings"));
    assert!(context.contains("evidence:"));

    finish(b, dir).await
}

#[tokio::test]
async fn tsk_04_verify_input_requires_a_reason() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-SCOPE")?;
    let (mut b, w) = setup(&dir.data).await?;
    let first = assign(&b, &w, "first", task("price")).await?;
    let worker = b
        .admit_child(
            first["child_session_id"].as_str().unwrap(),
            SessionRole::Worker,
        )
        .await?;
    b.result(&worker, "success", "Confirmed findings").await?;
    let mut verify = task("price");
    verify["inputs"] = json!([{"task":first["task_id"],"use":"verify"}]);
    assert_eq!(
        assign(&b, &w, "missing reason", verify.clone()).await?["error"]["code"],
        "task_verify_reason_required"
    );
    verify["inputs"][0]["reason"] = json!("Source changed");
    let admitted = assign(&b, &w, "verify", verify).await?;
    assert_eq!(admitted["ok"], true, "{admitted}");
    finish(b, dir).await
}

#[tokio::test]
async fn tsk_07_exact_subject_registration_and_required_contract() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-SCOPE")?;
    let (b, w) = setup(&dir.data).await?;
    let mut unknown = task("price");
    unknown["scope"]["owns"][0]["subject"] = json!("ITEM");
    let refused = assign(&b, &w, "unknown", unknown).await?;
    assert_eq!(refused["error"]["code"], "task_subject_unknown");
    assert_eq!(refused["error"]["detail"]["registered"], json!(["item"]));
    let refused = assign(&b, &w, "missing", json!({})).await?;
    assert_eq!(refused["error"]["code"], "task_fields_required");
    assert_eq!(
        refused["error"]["detail"]["fields"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    finish(b, dir).await
}

async fn finish(b: GraphBuilder, mut sandbox: butler_e2e::e2e::sandbox::Sandbox) -> Result {
    b.close().await?;
    sandbox.mark_success();
    Ok(())
}
