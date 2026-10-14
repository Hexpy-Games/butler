//! Direct Work action state and public-text policy through the gateway.
use super::*;
use butler_e2e::e2e::task_graph::{Error, GraphBuilder, actions};

#[tokio::test]
async fn task_graphs_direct_plan_progress() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-PROGRESS")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder.parent("butler/app-general").await?;
    let mut plan = actions(5);
    plan[0]["description"] = json!("네트워크 api_client.rs 검사");
    builder.plan(&mut work, "direct", plan).await?;
    builder
        .review(&mut work, "plan", "accept", json!([]))
        .await?;
    builder.checkpoint(&mut work,json!([
        {"actionKey":"a","status":"active"},{"actionKey":"b","status":"done"},
        {"actionKey":"c","status":"skipped"},{"actionKey":"d","status":"blocked","note":"입력 확인 필요 token=synthetic-credential"},
        {"actionKey":"e","status":"pending"}
    ])).await?;
    let id = butler_turn::btcc::encode_task_graph_id("work:", &work.view.work_id, "");
    let graph = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    let nodes = graph.data()["nodes"].as_array().unwrap();
    assert_eq!(
        nodes
            .iter()
            .map(|n| n["status"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["running", "done", "skipped", "blocked", "pending"]
    );
    assert_eq!(nodes[0]["title"], "네트워크 api_client.rs 검사");
    assert_eq!(nodes[3]["reason_code"], "action_blocked");
    assert_eq!(nodes[3]["blocked_reason"], "입력 확인 필요 [redacted]");
    assert_eq!(graph.data()["work_state"], "blocked");
    assert!(
        nodes
            .iter()
            .all(|n| n["handled_directly"] == true && n["session_id"] == "butler/app-general")
    );
    let document =
        s.gw.get(&format!(
            "/tasks/{}/document",
            nodes[0]["task_id"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(document.status, 200);
    assert!(
        document.data()["markdown"]
            .as_str()
            .unwrap()
            .contains("api_client.rs")
    );
    builder.close().await?;
    s.finish().await?;
    Ok(())
}
