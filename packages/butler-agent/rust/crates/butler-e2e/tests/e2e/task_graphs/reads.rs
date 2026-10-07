//! Public read assertions, keeping each test function within the code budget.
use super::*;
use butler_e2e::e2e::scenario::Scenario;

pub(super) async fn assert_plan(
    s: &Scenario,
    count: usize,
    chat: &str,
) -> Result<(), HarnessError> {
    let list = s.gw.get(&format!("/sessions/{chat}/task-graphs")).await?;
    assert_eq!(list.status, 200, "{}", list.text);
    assert_eq!(list.data()["graphs"].as_array().unwrap().len(), count);
    let graph =
        s.gw.get(&format!("/plans/graph-{count}-0/task-graph"))
            .await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    assert_graph(graph.data(), count);
    let view =
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{}", view.text);
    let worker = &view.data()["workers"][0];
    assert_eq!(worker["started_at"], fixture::START);
    assert_eq!(worker["finished_at"], fixture::FINISH);
    assert_eq!(worker["updated_at"], fixture::FINISH);
    assert_eq!(worker["model_display_name"], "GPT-6 Luna");
    assert!(
        list.data()["graphs"][0]["title"]
            .as_str()
            .unwrap()
            .contains("network api_client.rs")
    );
    assert_revision_pages(s, count, graph.data()).await?;
    assert_document(s, graph.data()).await?;
    for text in ["Work", "Steward", "delegate_to_worker"] {
        assert!(
            !list.data()["graphs"][0]["title"]
                .as_str()
                .unwrap()
                .contains(text)
        );
    }
    Ok(())
}

async fn assert_revision_pages(
    s: &Scenario,
    count: usize,
    graph: &serde_json::Value,
) -> Result<(), HarnessError> {
    let rev = graph["graph_revision"].as_str().unwrap();
    let again =
        s.gw.get(&format!("/plans/graph-{count}-0/task-graph?revision={rev}"))
            .await?;
    assert_eq!(
        again.data()["graph_revision"],
        graph["graph_revision"],
        "reads must not change revision"
    );
    assert_eq!(again.data()["nodes"], graph["nodes"]);
    let stale =
        s.gw.get(&format!("/plans/graph-{count}-0/task-graph?revision=stale"))
            .await?;
    assert_eq!(stale.status, 409);
    let page =
        s.gw.get(&format!("/plans/graph-{count}-0/task-graph?limit=2"))
            .await?;
    assert_eq!(page.data()["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(page.data()["totals"]["nodes"], 5);
    let cursor = page.data()["cursor"].as_str().unwrap();
    let next =
        s.gw.get(&format!(
            "/plans/graph-{count}-0/task-graph?cursor={cursor}&limit=2"
        ))
        .await?;
    assert_eq!(next.status, 200);
    assert_eq!(next.data()["nodes"][0]["title"], "Check");
    let last =
        s.gw.get(&format!(
            "/plans/graph-{count}-0/task-graph?cursor={}&limit=2",
            next.data()["cursor"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(last.status, 200);
    assert_eq!(last.data()["nodes"].as_array().unwrap().len(), 1);
    assert!(last.data()["cursor"].is_null());
    let union: Vec<_> = [page.data(), next.data(), last.data()]
        .into_iter()
        .flat_map(|p| p["nodes"].as_array().unwrap().iter().cloned())
        .collect();
    assert_eq!(union, *graph["nodes"].as_array().unwrap());
    Ok(())
}

async fn assert_document(s: &Scenario, graph: &serde_json::Value) -> Result<(), HarnessError> {
    let node = &graph["nodes"][3];
    let doc =
        s.gw.get(&format!(
            "/tasks/{}/document?revision={}",
            node["task_id"].as_str().unwrap(),
            node["document"]["revision"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(doc.status, 200, "{}", doc.text);
    assert_eq!(doc.data()["document_type"], "task");
    assert_eq!(doc.data()["kind"], "plan");
    for text in [
        "Combine",
        "All checks pass",
        "Build",
        "Check",
        "SPEC-1@rev-1",
        "api_client.rs is complete",
    ] {
        assert!(doc.data()["markdown"].as_str().unwrap().contains(text));
    }
    Ok(())
}
