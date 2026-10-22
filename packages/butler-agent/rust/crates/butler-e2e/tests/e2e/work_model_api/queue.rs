use super::*;

#[tokio::test]
async fn wma_03_done_rules_and_task_graph_cas() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed { s, project, .. } = seeded("WMA-03", "").await?;
    let running = data(s.gw.get("/canon/epics/wk_canon").await?, 200);
    assert_eq!(running["tasks"].as_array().unwrap().len(), 4);
    assert!(running.get("chain_id").is_none());
    assert!(running.get("graph_revision").is_none());
    let rejected =
        s.gw.patch(
            "/canon/epics/wk_canon",
            json!({"expected_revision":running["revision"],"status":"done"}),
        )
        .await?;
    assert_eq!(rejected.status, 409);
    assert_eq!(rejected.error_code(), Some("running"));
    let waiting = data(s.gw.get("/canon/epics/wk_queue").await?, 200);
    let q = queue(&s, "wk_queue").await?;
    let changed = data(
        edit_queue(
            &s,
            "wk_queue",
            "ch_queue",
            &q["task_graph_revision"],
            json!([{"op":"split_stack","chain_id":"ch_queue","index":1}]),
        )
        .await?,
        200,
    );
    let stale=s.gw.patch("/canon/epics/wk_queue",json!({"expected_revision":waiting["revision"],"expected_task_graph_revision":q["task_graph_revision"],"status":"done"})).await?;
    assert_eq!(stale.status, 409);
    let latest = data(s.gw.get("/canon/epics/wk_queue").await?, 200);
    assert_eq!(
        latest["task_graph_revision"],
        changed["task_graph_revision"]
    );
    for page in [
        overview(&s, &project).await?["plans"][0].clone(),
        data(s.gw.get("/canon/plans/pl_p14").await?, 200),
    ] {
        let card = page["works"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "wk_queue")
            .unwrap();
        assert_eq!(card["task_graph_revision"], latest["task_graph_revision"]);
    }
    let done=data(s.gw.patch("/canon/epics/wk_queue",json!({"expected_revision":latest["revision"],"expected_task_graph_revision":latest["task_graph_revision"],"status":"done"})).await?,200);
    assert_eq!(done["run_state"], "done");
    assert!(
        done["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["status"] == "cancelled" && t["blocked_reason"].is_string())
    );
    s.finish().await
}
#[tokio::test]
async fn wma_04_task_delete_split_cas_atomic_batch_and_event() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed { s, chat, .. } = seeded("WMA-04", "").await?;
    let q = queue(&s, "wk_canon").await?;
    assert_eq!(
        step_ids(&q),
        vec![
            vec!["tk_schema"],
            vec!["tk_crud", "tk_board"],
            vec!["tk_api"]
        ]
    );
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let split = data(
        edit_queue(
            &s,
            "wk_canon",
            "ch_canon",
            &q["task_graph_revision"],
            json!([{"op":"split_stack","chain_id":"ch_canon","index":1}]),
        )
        .await?,
        200,
    );
    assert_eq!(
        step_ids(&split),
        vec![
            vec!["tk_schema"],
            vec!["tk_crud"],
            vec!["tk_board"],
            vec!["tk_api"]
        ]
    );
    let deleted=data(edit_queue(&s,"wk_canon","ch_canon",&split["task_graph_revision"],json!([{"op":"delete","chain_id":"ch_canon","task_id":"tk_crud"},{"op":"delete","chain_id":"ch_canon","task_id":"tk_board"}])).await?,200);
    assert_eq!(step_ids(&deleted), vec![vec!["tk_schema"], vec!["tk_api"]]);
    let stale = edit_queue(
        &s,
        "wk_canon",
        "ch_canon",
        &q["task_graph_revision"],
        json!([{"op":"delete","chain_id":"ch_canon","task_id":"tk_api"}]),
    )
    .await?;
    assert_eq!(stale.status, 409);
    assert_eq!(
        stale.body["error"]["current"]["revision"],
        deleted["task_graph_revision"]
    );
    let invalid=edit_queue(&s,"wk_canon","ch_canon",&deleted["task_graph_revision"],json!([{"op":"delete","chain_id":"ch_canon","task_id":"tk_api"},{"op":"delete","chain_id":"ch_canon","task_id":"missing"}])).await?;
    assert_eq!(invalid.status, 400);
    assert_eq!(queue(&s, "wk_canon").await?, deleted);
    let changed = event(&stream, "work_model.changed", "wk_canon").await?;
    assert_eq!(changed["payload"]["scope"], "tasks");
    assert_eq!(changed["payload"]["session_id"], chat);
    assert!(changed["payload"].get("plan_id").is_none());
    assert!(changed["payload"]["task_graph_revision"].is_i64());
    drop(stream);
    s.finish().await
}
#[tokio::test]
async fn wma_05_task_hold_decisions_survive_restart_and_resolve() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for decision in ["run_anyway", "delete"] {
        let Seed { mut s, .. } = seeded(&format!("WMA-05-{decision}"), "").await?;
        let q = queue(&s, "wk_queue").await?;
        assert_eq!(
            step_ids(&q),
            vec![
                vec!["tk_queue"],
                vec!["tk_queue_ui"],
                vec!["tk_queue_followup"]
            ]
        );
        assert_eq!(
            q["chains"][0]["hold_questions"].as_array().unwrap().len(),
            1
        );
        s.restart().await?;
        assert_eq!(queue(&s, "wk_queue").await?, q);
        let result=data(edit_queue(&s,"wk_queue","ch_queue",&q["task_graph_revision"],json!([{"op":"decide_hold","chain_id":"ch_queue","id":"hd_queue","decision":decision}])).await?,200);
        assert_eq!(result["chains"][0]["hold_questions"], json!([]));
        if decision == "run_anyway" {
            assert_eq!(
                result["chains"][0]["ready_task_ids"],
                json!(["tk_queue_ui"])
            );
            assert_eq!(
                result["chains"][0]["steps"][2]["tasks"][0]["status"],
                "waiting"
            );
        } else {
            assert_eq!(step_ids(&result), vec![vec!["tk_queue"]]);
        }
        s.restart().await?;
        assert_eq!(queue(&s, "wk_queue").await?, result);
        if decision == "run_anyway" {
            let retried = data(
                edit_queue(
                    &s,
                    "wk_queue",
                    "ch_queue",
                    &result["task_graph_revision"],
                    json!([{"op":"start_now","chain_id":"ch_queue","task_id":"tk_queue"}]),
                )
                .await?,
                200,
            );
            assert_eq!(retried["chains"][1]["ready_task_ids"], json!(["tk_queue"]));
            assert_eq!(
                retried["chains"][1]["steps"][0]["tasks"][0]["status"],
                "pending"
            );
        }
        s.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn wma_06_task_edits_preserve_canon_membership_and_support_heads() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let Seed { s, project, .. } = seeded("WMA-06", "").await?;
    let canon = overview(&s, &project).await?;
    let q = queue(&s, "wk_canon").await?;
    let detached = data(
        edit_queue(
            &s,
            "wk_canon",
            "ch_canon",
            &q["task_graph_revision"],
            json!([{"op":"start_now","chain_id":"ch_canon","task_id":"tk_api"}]),
        )
        .await?,
        200,
    );
    assert_eq!(detached["chains"].as_array().unwrap().len(), 2);
    let head = detached["chains"][1]["id"].as_str().unwrap();
    let joined=data(edit_queue(&s,"wk_canon","ch_canon",&detached["task_graph_revision"],json!([{"op":"move_to_chain","chain_id":head,"task_id":"tk_api","target_chain_id":"ch_canon","target":"tk_crud"}])).await?,200);
    assert_eq!(
        step_ids(&joined),
        vec![vec!["tk_schema"], vec!["tk_crud", "tk_board", "tk_api"]]
    );
    let moved = data(
        edit_queue(
            &s,
            "wk_canon",
            "ch_canon",
            &joined["task_graph_revision"],
            json!([{"op":"move_to_new_step","chain_id":"ch_canon","task_id":"tk_api","index":1}]),
        )
        .await?,
        200,
    );
    assert_eq!(
        step_ids(&moved),
        vec![
            vec!["tk_schema"],
            vec!["tk_api"],
            vec!["tk_crud", "tk_board"]
        ]
    );
    let merged=data(edit_queue(&s,"wk_canon","ch_canon",&moved["task_graph_revision"],
        json!([{"op":"join_stack","chain_id":"ch_canon","task_id":"tk_api","target":"tk_crud"}])).await?,200);
    assert_eq!(step_ids(&merged), step_ids(&joined));
    let pinned = edit_queue(
        &s,
        "wk_canon",
        "ch_canon",
        &merged["task_graph_revision"],
        json!([{"op":"move_to_new_step","chain_id":"ch_canon","task_id":"tk_schema","index":1}]),
    )
    .await?;
    assert_eq!(pinned.status, 400);
    assert_eq!(queue(&s, "wk_canon").await?, merged);
    let latest = overview(&s, &project).await?;
    assert_eq!(
        ids(&canon["plans"][0]["works"]),
        ids(&latest["plans"][0]["works"])
    );
    assert_eq!(ids(&canon["backlog"]), ids(&latest["backlog"]));
    s.finish().await
}
