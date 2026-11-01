//! Controlled dispatch tests the gap before a directed child Turn is admitted.
use super::*;
use butler_e2e::e2e::task_graph::{GraphBuilder, actions};
use butler_turn::btcc::SubsessionDirectionRequest;

#[tokio::test]
async fn epic_delete_review_ended_step_waits_for_pending_direction_without_live_child()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, _) =
        setup("EPIC-DELETE-PENDING-DIRECTION", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    s.agent.terminate().await?;
    let mut graph = GraphBuilder::open(&s.sandbox.data)
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    let mut parent = graph
        .parent("direction-parent")
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    graph
        .plan(&mut parent, "steward", actions(1))
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    graph
        .review(&mut parent, "plan", "accept", json!([]))
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    let child = graph
        .steward(&parent, "Check the evidence")
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    let canon = db(&s)?;
    let relation: String = canon.query_row(
        "SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1",
        [&child.scope.session_id],
        |r| r.get(0),
    )?;
    let direction = graph
        .children
        .steer(SubsessionDirectionRequest {
            parent_session_id: parent.scope.session_id.clone(),
            parent_turn_id: parent.scope.turn_id.clone(),
            source_message_id: parent.scope.turn_id.clone(),
            relation_id: Some(relation.clone()),
            work_id: None,
            safe_title: None,
            instruction: "Check the remaining evidence".into(),
            child_role: butler_turn::workspace::SessionRole::Steward,
            access_mode: "full_access".into(),
            schedule_run: None,
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    assert_eq!(direction["status"], "pending");
    // The integrated read fixture pins the durable end/admission window. The
    // model and direction-Work barriers in the Agent are both after admission.
    canon.execute("UPDATE btcc_turns SET semantic_state='delivered'", [])?;
    canon.execute("INSERT INTO canon_epic_work_links(epic_id,btcc_work_id,session_id,linked_at,linked_by) VALUES(?1,?2,?3,0,'{}')",rusqlite::params![id,parent.view.work_id,parent.scope.session_id])?;
    canon.execute(
        "INSERT INTO canon_session_queue_chains VALUES(?1,'chain',NULL)",
        [&parent.scope.session_id],
    )?;
    canon.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin,started_at,turn_ended_at) VALUES(?1,?2,'chain',0,0,'running','detach',0,1)",rusqlite::params![parent.scope.session_id,id])?;
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM btcc_turns WHERE semantic_state IN ('admitted','delivery_committed')",[],|r|r.get(0))?,0);
    // Isolate each arm of WorkDelegationOpen, including a Worker relation.
    for role in ["steward", "worker"] {
        canon.execute("UPDATE btcc_session_relations SET activity_role=?2,activity_terminal=1 WHERE relation_id=?1",rusqlite::params![relation,role])?;
        assert!(
            butler_canon::store::runtime::epic_delete_running(&canon, id)
                .map_err(|e| HarnessError(e.to_string()))?,
            "{role}: pending direction"
        );
        canon.execute(
            "UPDATE btcc_subsession_directions SET status='applied' WHERE relation_id=?1",
            [&relation],
        )?;
        assert!(
            !butler_canon::store::runtime::epic_delete_running(&canon, id)
                .map_err(|e| HarnessError(e.to_string()))?,
            "{role}: terminal child without direction"
        );
        canon.execute(
            "UPDATE btcc_session_relations SET activity_terminal=0 WHERE relation_id=?1",
            [&relation],
        )?;
        assert!(
            butler_canon::store::runtime::epic_delete_running(&canon, id)
                .map_err(|e| HarnessError(e.to_string()))?,
            "{role}: open relation"
        );
        canon.execute(
            "UPDATE btcc_subsession_directions SET status='pending' WHERE relation_id=?1",
            [&relation],
        )?;
    }
    drop(canon);
    graph
        .close()
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    s.finish().await?;
    server.abort();
    Ok(())
}
