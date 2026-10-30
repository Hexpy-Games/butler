//! WMA local canon and work queue flows over the authenticated HTTP surface.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
mod attachment_contracts;
mod attachment_plans;
mod attachment_recovery;
mod attachment_sizes;
mod attachments;
mod canon;
mod events;
mod separation;
mod sidebar;
mod sidebar_fixture;
mod tags;
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
const SEEDED_CHATS: [&str; 7] = [
    "chat_canon",
    "chat_queue",
    "chat_blocks",
    "chat_docs",
    "chat_images",
    "chat_login",
    "chat_crates",
];
async fn seeded(id: &str, extra: &str) -> Result<Seed, HarnessError> {
    let mut s = Setup::new(id)?.start().await?;
    let project = project(&s).await?;
    // Every 과제 the seed links to a conversation gets a real one: startup removes links to
    // sessions that no longer exist.
    let mut chats = Vec::new();
    let mut hints = Vec::new();
    for _ in SEEDED_CHATS {
        let c = data(s.gw.post("/sessions", json!({"kind":"chat"})).await?, 201);
        chats.push(c["session"]["id"].as_str().unwrap().to_owned());
        hints.push(c["session"]["session_hint"].as_str().unwrap().to_owned());
    }
    s.agent.terminate().await?;
    // Static preview-14 data is seeded while stopped, before the measured start.
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let seed = SEEDED_CHATS.iter().zip(&hints).fold(
        include_str!("../../fixtures/work-model-p14/seed.sql")
            .replace("'butler'", &format!("'{project}'")),
        |seed, (name, hint)| seed.replace(&format!("'{name}'"), &format!("'{hint}'")),
    );
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    db.execute_batch(include_str!(
        "../../fixtures/work-model-p14/merged-schema.sql"
    ))?;
    db.execute_batch(&seed)?;
    db.execute_batch(extra)?;
    drop(db);
    s.restart().await?;
    Ok(Seed {
        s,
        project,
        chat: chats[0].clone(),
    })
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
