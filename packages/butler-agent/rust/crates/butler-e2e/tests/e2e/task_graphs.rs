//! Read-only Task graph public API, using today's durable records.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod events;
mod fixture;
mod perf;
mod progress;
mod reads;
mod scale;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn task_graphs_existing_plans_documents_and_dependencies() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TASK-GRAPH-01")?.start().await?;
    let mut chats = Vec::new();
    for count in [1, 2, 6] {
        let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
        assert_eq!(created.status, 201);
        chats.push((
            count,
            created.data()["session"]["id"].as_str().unwrap().to_owned(),
            created.data()["session"]["session_hint"]
                .as_str()
                .unwrap()
                .to_owned(),
        ));
    }
    let empty = s.gw.get("/sessions/general/task-graphs").await?;
    assert_eq!(empty.status, 200);
    assert_eq!(
        empty.data()["graphs"].as_array().unwrap().as_slice(),
        [] as [serde_json::Value; 0]
    );
    s.agent.terminate().await?;
    for (count, _, hint) in &chats {
        fixture::seed(&s.sandbox.data, hint, *count)?;
    }
    s.gw = s.agent.start_again().await?;
    for (count, chat, _) in chats {
        reads::assert_plan(&s, count, &chat).await?;
    }
    assert_eq!(s.gw.get("/plans/missing/task-graph").await?.status, 404);
    assert_eq!(s.gw.get("/tasks/missing/document").await?.status, 404);
    s.finish().await
}

fn assert_graph(graph: &serde_json::Value, count: usize) {
    let nodes = graph["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 5);
    assert_eq!(graph["edges"].as_array().unwrap().len(), 5);
    assert_eq!(nodes[0]["status"], "completed");
    assert_eq!(nodes[1]["status"], "failed");
    assert_eq!(nodes[2]["status"], "cancelled");
    assert_eq!(nodes[3]["status"], "blocked");
    assert_eq!(nodes[4]["status"], "blocked");
    assert_eq!(nodes[0]["started_at"], fixture::START);
    assert_eq!(nodes[0]["finished_at"], fixture::FINISH);
    assert_eq!(nodes[0]["model_display_name"], "GPT-6 Luna");
    assert_eq!(nodes[0]["session_id"], format!("worker-graph-{count}-0-a"));
    assert!(nodes[3]["session_id"].is_null());
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|edge| nodes.iter().any(|n| n["task_id"] == edge["from"])
                && nodes.iter().any(|n| n["task_id"] == edge["to"]))
    );
}

#[tokio::test]
async fn task_graphs_legacy_delegation_groups() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TASK-GRAPH-GROUP")?.start().await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let hint = created.data()["session"]["session_hint"]
        .as_str()
        .unwrap()
        .to_owned();
    s.agent.terminate().await?;
    fixture::seed(&s.sandbox.data, &hint, 1)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("UPDATE btcc_subsession_delegations SET packet_json=json_remove(packet_json,'$.parent_work_ref'); DELETE FROM btcc_guided_work_plan_revisions; DELETE FROM btcc_guided_works;")?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let list = s.gw.get(&format!("/sessions/{chat}/task-graphs")).await?;
    assert_eq!(list.status, 200, "{}", list.text);
    assert_eq!(list.data()["graphs"].as_array().unwrap().len(), 1);
    let id = list.data()["graphs"][0]["graph_id"].as_str().unwrap();
    let graph = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    assert_eq!(graph.data()["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(graph.data()["edges"].as_array().unwrap().len(), 2);
    let document = s.gw.get("/tasks/task-1-0-b/document").await?;
    assert_eq!(document.status, 200);
    assert!(
        document.data()["markdown"]
            .as_str()
            .unwrap()
            .contains("Prepare")
    );
    s.finish().await
}
