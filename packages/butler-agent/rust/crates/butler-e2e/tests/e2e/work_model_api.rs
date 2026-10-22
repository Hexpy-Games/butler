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
    held_chat: String,
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
    Ok(Seed {
        s,
        project,
        chat: chats[0].clone(),
        held_chat: chats[1].clone(),
    })
}
async fn queue(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/sessions/{chat}/work-queue")).await?,
        200,
    ))
}
async fn edit_queue(
    s: &Scenario,
    chat: &str,
    chain: &str,
    revision: &Value,
    ops: Value,
) -> Result<Reply, HarnessError> {
    s.gw.post(
        &format!("/sessions/{chat}/work-queue/edits"),
        json!({"ops":ops,"expected_graph_revisions":{chain:revision}}),
    )
    .await
}
fn step_ids(queue: &Value) -> Vec<Vec<String>> {
    queue["chains"][0]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| ids(&s["works"]))
        .collect()
}
async fn event(stream: &LiveEvents, topic: &str, id: &str) -> Result<Value, HarnessError> {
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == topic && (e["payload"]["id"] == id || e["payload"]["session_id"] == id)
        })
        .await
}
