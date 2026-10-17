//! Read-only BTCC task graph public API through the real stub gateway.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod events;
mod fidelity;
mod fixture;
mod ownership;
mod perf;
mod progress;
mod reads;
mod scale;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn task_graphs_existing_plans_documents_and_dependencies() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-01")?.start().await?;
    let mut chats = Vec::new();
    for count in [1, 2, 6] {
        let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
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
    assert_eq!(empty.data()["total"], 0);
    for (count, _, hint) in &chats {
        Box::pin(fixture::seed(&s.sandbox.data, hint, *count)).await?;
    }
    for (count, chat, _) in chats {
        reads::assert_plan(&s, count, &chat).await?;
    }
    assert_eq!(s.gw.get("/plans/missing/task-graph").await?.status, 404);
    assert_eq!(s.gw.get("/tasks/missing/document").await?.status, 404);
    s.finish().await
}
fn assert_graph(graph: &serde_json::Value, _count: usize) {
    let nodes = graph["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 5);
    assert_eq!(graph["edges"].as_array().unwrap().len(), 5);
    assert_eq!(
        nodes
            .iter()
            .map(|n| n["status"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["done", "failed", "done", "pending", "pending"]
    );
    assert_eq!(nodes[0]["model_display_name"], "GPT-6 Luna");
    assert!(
        nodes[0]["session_id"]
            .as_str()
            .unwrap()
            .starts_with("worker-")
    );
    assert!(nodes[3]["session_id"].is_null());
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| nodes.iter().any(|n| n["task_id"] == e["from"])
                && nodes.iter().any(|n| n["task_id"] == e["to"]))
    );
}
