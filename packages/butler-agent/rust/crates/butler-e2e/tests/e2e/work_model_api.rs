//! WMA local canon and work queue flows over the authenticated HTTP surface.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
mod canon;
mod events;
mod queue;
use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    gateway::Reply,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

fn data(reply: Reply, status: u16) -> Value {
    assert_eq!(reply.status, status, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}
async fn project(s: &Scenario) -> Result<String, HarnessError> {
    let created = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"API 작업"}),
        )
        .await?,
        201,
    );
    Ok(created["project"]["id"].as_str().unwrap().to_owned())
}
async fn create_plan(s: &Scenario, project: &str, title: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":title}),
        )
        .await?,
        201,
    ))
}
async fn create_epic(s: &Scenario, project: &str, title: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":title}),
        )
        .await?,
        201,
    ))
}
fn ids(works: &Value) -> Vec<String> {
    works
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["id"].as_str().unwrap().to_owned())
        .collect()
}
async fn overview(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/projects/{project}/canon")).await?,
        200,
    ))
}
struct Seed {
    s: Scenario,
    project: String,
    chat: String,
}
async fn seeded(id: &str, extra: &str) -> Result<Seed, HarnessError> {
    let mut s = Setup::new(id)?.start().await?;
    let project = project(&s).await?;
    let mut chats = Vec::new();
    let mut hints = Vec::new();
    for _ in 0..2 {
        let c = data(s.gw.post("/sessions", json!({"kind":"chat"})).await?, 201);
        chats.push(c["session"]["id"].as_str().unwrap().to_owned());
        hints.push(c["session"]["session_hint"].as_str().unwrap().to_owned());
    }
    super::work_model_cutover::completed(&s).await?;
    s.agent.terminate().await?;
    // Static preview-14 data is seeded while stopped, before the measured start.
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let seed = include_str!("../../fixtures/work-model-p14/seed.sql")
        .replace("'butler'", &format!("'{project}'"))
        .replace("'chat_canon'", &format!("'{}'", hints[0]))
        .replace("'chat_queue'", &format!("'{}'", hints[1]));
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    db.execute_batch(&seed)?;
    db.execute_batch(extra)?;
    drop(db);
    s.restart().await?;
    // Startup correctly recovered the offline lease. Establish the active
    // fixture after recovery so running-edit assertions still exercise a run.
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<String, _, _>(
            "SELECT status FROM wm_tasks WHERE id='tk_schema'",
            [],
            |r| r.get(0)
        )?,
        "pending"
    );
    assert_eq!(db.query_row::<i64,_,_>("SELECT count(*) FROM wm_attempts WHERE id='at_schema' AND status='interrupted' AND recovered_at IS NOT NULL", [], |r| r.get(0))?, 1);
    db.execute_batch("BEGIN IMMEDIATE;
        UPDATE wm_attempts SET status='running',finished_at=NULL,recovered_at=NULL WHERE id='at_schema';
        UPDATE wm_tasks SET status='running',assignee_session_id=(SELECT session_id FROM wm_attempts WHERE id='at_schema') WHERE id='tk_schema';
        UPDATE wm_works SET run_state='running' WHERE id='wk_canon';
        UPDATE wm_counts SET count=0 WHERE key LIKE 'run_state:%';
        INSERT INTO wm_counts(scope_kind,scope_ref,key,count)
          SELECT scope_kind,scope_ref,'run_state:'||run_state,count(*) FROM wm_works
          GROUP BY scope_kind,scope_ref,run_state
          ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=excluded.count;
        COMMIT;")?;
    drop(db);
    Ok(Seed {
        s,
        project,
        chat: chats[0].clone(),
    })
}
async fn queue(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    Ok(data(s.gw.get(&format!("/works/{chat}/tasks")).await?, 200))
}
async fn edit_queue(
    s: &Scenario,
    chat: &str,
    _chain: &str,
    revision: &Value,
    ops: Value,
) -> Result<Reply, HarnessError> {
    s.gw.post(
        &format!("/works/{chat}/tasks/edits"),
        json!({"ops":ops,"expected_task_graph_revision":revision}),
    )
    .await
}
fn step_ids(queue: &Value) -> Vec<Vec<String>> {
    queue["chains"][0]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| ids(&s["tasks"]))
        .collect()
}
async fn event(stream: &LiveEvents, topic: &str, id: &str) -> Result<Value, HarnessError> {
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == topic
                && (e["payload"]["id"] == id
                    || e["payload"]["work_id"] == id
                    || e["payload"]["session_id"] == id)
        })
        .await
}
