//! Existing direct-plan checkpoint states, without delegated assignments.
use super::*;

#[tokio::test]
async fn task_graphs_direct_plan_progress() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TASK-GRAPH-PROGRESS")?.start().await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    let hint = created.data()["session"]["session_hint"]
        .as_str()
        .unwrap()
        .to_owned();
    s.agent.terminate().await?;
    fixture::seed(&s.sandbox.data, &hint, 1)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("DELETE FROM btcc_steward_results; DELETE FROM btcc_subsession_delegations; DELETE FROM btcc_session_relations;")?;
    let states = json!([
        {"actionKey":"a","status":"active"},
        {"actionKey":"b","status":"done"},
        {"actionKey":"c","status":"skipped"},
        {"actionKey":"d","status":"blocked"},
        {"actionKey":"e","status":"pending"}
    ]);
    db.execute("INSERT INTO btcc_guided_work_checkpoint_revisions(checkpoint_revision_id,work_id,revision,plan_revision_id,stage,public_summary,next_step,action_states_json,result_sequence,origin_turn_id,created_at) VALUES('checkpoint','source-1-0',1,'graph-1-0','execution','Progress','Prepare',?1,0,'parent-turn-1','2026-10-02T00:00:00Z')",[states.to_string()])?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let graph = s.gw.get("/plans/graph-1-0/task-graph").await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    let nodes = graph.data()["nodes"].as_array().unwrap();
    let statuses: Vec<_> = nodes
        .iter()
        .map(|node| node["status"].as_str().unwrap())
        .collect();
    assert_eq!(
        statuses,
        ["running", "completed", "cancelled", "blocked", "blocked"]
    );
    assert_eq!(graph.data()["state"], "running");
    assert_eq!(
        graph.data()["counts"],
        json!({"total":5,"running":1,"completed":1,"failed":0,"cancelled":1,"blocked":2})
    );
    assert_eq!(graph.data()["edges"].as_array().unwrap().len(), 5);
    assert!(
        nodes
            .iter()
            .all(|node| node["session_id"].is_null() && node["started_at"].is_null())
    );
    let id = nodes[0]["task_id"].as_str().unwrap();
    let document = s.gw.get(&format!("/tasks/{id}/document")).await?;
    assert_eq!(document.status, 200);
    assert_eq!(document.data()["status"], "running");
    let finished = json!([
        {"actionKey":"a","status":"done"},
        {"actionKey":"b","status":"done"},
        {"actionKey":"c","status":"skipped"},
        {"actionKey":"d","status":"done"},
        {"actionKey":"e","status":"done"}
    ]);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute("INSERT INTO btcc_guided_work_checkpoint_revisions(checkpoint_revision_id,work_id,revision,plan_revision_id,stage,public_summary,next_step,action_states_json,result_sequence,origin_turn_id,created_at) VALUES('finished','source-1-0',2,'graph-1-0','reporting','Done','Done',?1,0,'parent-turn-1','2026-10-03T00:00:00Z')",[finished.to_string()])?;
    drop(db);
    let latest = s.gw.get("/plans/graph-1-0/task-graph").await?;
    assert_eq!(latest.status, 200);
    assert_eq!(latest.data()["state"], "done");
    assert_eq!(latest.data()["counts"]["completed"], 4);
    assert_eq!(latest.data()["counts"]["cancelled"], 1);
    assert_ne!(
        latest.data()["graph_revision"],
        graph.data()["graph_revision"]
    );
    s.finish().await
}
