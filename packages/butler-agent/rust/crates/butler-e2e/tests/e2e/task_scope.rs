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
async fn tsk_01_running_overlap_names_task_status_cells_and_ref() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-SCOPE")?;
    let (b, w) = setup(&dir.data).await?;
    let first = assign(&b, &w, "first", task("price")).await?;
    let mut other = request(&w, "overlap", task("price"));
    other.action_key = "b".into();
    let refused = b.children.delegate_worker(other, &w.view).await?;
    assert_eq!(refused["error"]["code"], "task_scope_overlap");
    let overlap = &refused["error"]["detail"]["overlaps"][0];
    assert_eq!(overlap["task"], first["task_id"]);
    assert_eq!(overlap["status"], "active");
    assert_eq!(overlap["cells"], json!(["item:price"]));
    assert!(overlap.get("result_ref").is_some());
    assert_eq!(
        b.children
            .repository()
            .work_tasks(w.view.work_id)
            .await?
            .len(),
        1
    );
    finish(b, dir).await
}

#[tokio::test]
async fn tsk_02_narrow_starts_and_merge_steers_without_a_new_worker() -> Result {
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
    let mut broad = task("price");
    broad["overlap"] = json!({"resolution":"narrow","reason":"Split aspects"});
    assert_eq!(
        assign(&b, &w, "broad", broad).await?["error"]["code"],
        "task_scope_overlap"
    );
    let narrow = assign(&b, &w, "narrow", task("spec")).await?;
    assert_eq!(narrow["ok"], true);
    let mut merge = task("price");
    merge["overlap"] = json!({"resolution":"merge","reason":"One owner"});
    let merged = assign(&b, &w, "also check tax", merge).await?;
    assert_eq!(merged["ok"], true, "{merged}");
    assert_eq!(merged["relation_id"], first["relation_id"]);
    let db = db(&dir.data)?;
    let direction: String = db.query_row(
        "SELECT instruction FROM btcc_subsession_directions WHERE relation_id=?1",
        [first["relation_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert!(direction.contains("also check tax"));
    let tasks = b.children.repository().work_tasks(w.view.work_id).await?;
    assert_eq!(tasks.len(), 2);
    assert!(
        tasks[0]
            .overlaps
            .iter()
            .any(|o| o.resolution == "merge" && o.reason == "One owner")
    );
    assert!(
        tasks[0]
            .overlaps
            .iter()
            .any(|o| o.resolution == "narrow" && o.reason == "Split aspects")
    );
    assert_eq!(worker.session, first["child_session_id"]);
    finish(b, dir).await
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
    wait["overlap"] = json!({"resolution":"wait","reason":"Use current result first"});
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
    assert_eq!(
        tasks[1].merge_after,
        vec![first["task_id"].as_str().unwrap()]
    );
    assert_eq!(tasks[1].inputs.len(), 1);
    assert_eq!(tasks[1].inputs[0].task, first["task_id"].as_str().unwrap());
    let context:String=db.query_row("SELECT json_extract(packet_json,'$.task_context') FROM btcc_subsession_delegations WHERE relation_id=?1",[waiting["relation_id"].as_str().unwrap()],|r|r.get(0))?;
    assert!(context.contains("Confirmed complete findings"));
    assert!(context.contains("evidence:"));

    finish(b, dir).await
}

#[tokio::test]
async fn tsk_04_done_cells_require_inputs_and_verify_reason_is_recorded() -> Result {
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
    let refused = assign(&b, &w, "recheck", task("price")).await?;
    let prior = &refused["error"]["detail"]["overlaps"][0];
    assert_eq!(prior["status"], "done");
    assert!(
        prior["result_ref"]
            .as_str()
            .unwrap()
            .starts_with("evidence:")
    );
    let mut verify = task("price");
    verify["inputs"] = json!([{"task":first["task_id"],"use":"verify"}]);
    assert_eq!(
        assign(&b, &w, "missing reason", verify.clone()).await?["error"]["code"],
        "task_verify_reason_required"
    );
    verify["inputs"][0]["reason"] = json!("Source changed");
    let admitted = assign(&b, &w, "verify", verify).await?;
    assert_eq!(admitted["ok"], true, "{admitted}");
    let tasks = b.children.repository().work_tasks(w.view.work_id).await?;
    assert_eq!(tasks[1].overlaps[0].resolution, "verify");
    assert_eq!(tasks[1].overlaps[0].reason, "Source changed");
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

#[tokio::test]
async fn tsk_01_folder_paths_and_empty_aspects_reserve_their_children() -> Result {
    butler_e2e::gate!();
    let cases = [
        (
            json!({"paths":["src/"]}),
            json!({"paths":["./src/nested/../nested/file.rs"]}),
            "path:src/nested/file.rs",
        ),
        (
            json!({"owns":[{"subject":"item","aspects":[]}]}),
            json!({"owns":[{"subject":"item","aspects":["price"]}]}),
            "item:price",
        ),
    ];
    for (scope, other, cell) in cases {
        let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-CELLS")?;
        let (b, w) = setup(&dir.data).await?;
        let mut first = task("price");
        first["scope"] = scope;
        let assigned = assign(&b, &w, "first", first).await?;
        let mut second = task("price");
        second["scope"] = other;
        let mut request = request(&w, "overlap", second);
        request.action_key = "b".into();
        let refused = b.children.delegate_worker(request, &w.view).await?;
        let overlap = &refused["error"]["detail"]["overlaps"][0];
        assert_eq!(overlap["task"], assigned["task_id"]);
        assert_eq!(overlap["cells"], json!([cell]));
        finish(b, dir).await?;
    }
    Ok(())
}
