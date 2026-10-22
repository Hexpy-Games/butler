use super::*;

#[tokio::test]
async fn wma_03_done_rejects_running_and_releases_waiting_follower() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed {
        s, project, chat, ..
    } = seeded(
        "WMA-03",
        "UPDATE wm_works SET visibility='canon',canon_status='planned',scope_kind='project',scope_ref=(SELECT scope_ref FROM wm_works WHERE id='wk_canon'),plan_id='pl_p14',plan_rank='C' WHERE id='wk_schema';",
    )
    .await?;
    let path = "/canon/epics/wk_canon";
    let running = data(s.gw.get(path).await?, 200);
    assert_eq!(running["specs"].as_array().unwrap().len(), 1);
    assert_eq!(running["specs"][0]["active_revision"], 1);
    assert_eq!(running["tasks"].as_array().unwrap().len(), 3);
    let rejected =
        s.gw.patch(
            path,
            json!({"expected_revision":running["revision"],"status":"done"}),
        )
        .await?;
    assert_eq!(rejected.status, 409);
    assert_eq!(rejected.error_code(), Some("running"));
    assert_eq!(data(s.gw.get(path).await?, 200), running);
    let q = queue(&s, &chat).await?;
    let q = data(
        edit_queue(
            &s,
            &chat,
            "ch_canon",
            &q["chains"][0]["graph_revision"],
            json!([{"op":"split_stack","chain_id":"ch_canon","index":1}]),
        )
        .await?,
        200,
    );
    assert_eq!(
        step_ids(&q),
        vec![
            vec!["wk_canon"],
            vec!["wk_schema"],
            vec!["wk_store"],
            vec!["wk_api"]
        ]
    );
    let waiting = data(s.gw.get("/canon/epics/wk_schema").await?, 200);
    let done = data(
        s.gw.patch(
            "/canon/epics/wk_schema",
            json!({"expected_revision":waiting["revision"],"expected_graph_revision":q["chains"][0]["graph_revision"],"status":"done"}),
        )
        .await?,
        200,
    );
    assert_eq!(done["canon_status"], "done");
    assert_eq!(done["run_state"], "done");
    assert!(done["result_reported_at"].is_i64());
    let q = queue(&s, &chat).await?;
    assert_eq!(
        step_ids(&q),
        vec![
            vec!["wk_canon"],
            vec!["wk_schema"],
            vec!["wk_store"],
            vec!["wk_api"]
        ]
    );
    assert_eq!(q["chains"][0]["ready_work_ids"], json!(["wk_store"]));
    assert_eq!(q["chains"][0]["steps"][1]["works"][0]["run_state"], "done");
    assert_eq!(
        overview(&s, &project).await?["plans"][0]["works"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    s.finish().await
}

#[tokio::test]
async fn wma_04_queue_delete_split_cas_and_atomic_batch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed { s, chat, .. } = seeded("WMA-04", "").await?;
    let q = queue(&s, &chat).await?;
    assert_eq!(q["chains"].as_array().unwrap().len(), 1);
    assert_eq!(
        step_ids(&q),
        vec![
            vec!["wk_canon"],
            vec!["wk_schema", "wk_store"],
            vec!["wk_api"]
        ]
    );
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let deleted = data(
        edit_queue(
            &s,
            &chat,
            "ch_canon",
            &q["chains"][0]["graph_revision"],
            json!([{"op":"delete","chain_id":"ch_canon","work_id":"wk_schema"},
               {"op":"delete","chain_id":"ch_canon","work_id":"wk_store"}]),
        )
        .await?,
        200,
    );
    assert_eq!(step_ids(&deleted), vec![vec!["wk_canon"], vec!["wk_api"]]);
    assert_eq!(queue(&s, &chat).await?, deleted);
    assert_eq!(deleted["session_id"], chat);
    let changed = event(&stream, "work_queue.changed", &chat).await?;
    assert_eq!(changed["payload"]["session_id"], chat);
    assert_eq!(
        deleted["chains"][0]["steps"][0]["works"][0]["home_session_id"],
        chat
    );
    drop(stream);
    s.finish().await?;
    let Seed { s, chat, .. } = seeded("WMA-04-SPLIT", "").await?;
    let q = queue(&s, &chat).await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let split = data(
        edit_queue(
            &s,
            &chat,
            "ch_canon",
            &q["chains"][0]["graph_revision"],
            json!([{"op":"split_stack","chain_id":"ch_canon","index":1}]),
        )
        .await?,
        200,
    );
    assert_eq!(
        step_ids(&split),
        vec![
            vec!["wk_canon"],
            vec!["wk_schema"],
            vec!["wk_store"],
            vec!["wk_api"]
        ]
    );
    let deleted=data(edit_queue(&s,&chat,"ch_canon",&split["chains"][0]["graph_revision"],json!([{"op":"delete","chain_id":"ch_canon","work_id":"wk_schema"},{"op":"delete","chain_id":"ch_canon","work_id":"wk_store"}])).await?,200);
    assert_eq!(step_ids(&deleted), vec![vec!["wk_canon"], vec!["wk_api"]]);
    let stale = edit_queue(
        &s,
        &chat,
        "ch_canon",
        &q["chains"][0]["graph_revision"],
        json!([{"op":"delete","chain_id":"ch_canon","work_id":"wk_api"}]),
    )
    .await?;
    assert_eq!(stale.status, 409);
    assert_eq!(stale.error_code(), Some("conflict"));
    assert_eq!(
        stale.body["error"]["current"]["revision"],
        deleted["chains"][0]["graph_revision"]
    );
    let invalid=edit_queue(&s,&chat,"ch_canon",&deleted["chains"][0]["graph_revision"],json!([{"op":"delete","chain_id":"ch_canon","work_id":"wk_api"},{"op":"delete","chain_id":"ch_canon","work_id":"missing"}])).await?;
    assert_eq!(invalid.status, 400);
    assert_eq!(queue(&s, &chat).await?, deleted);
    assert_eq!(deleted["session_id"], chat);
    let changed = event(&stream, "work_queue.changed", &chat).await?;
    assert!(changed["payload"]["revision"].as_i64() > q["chains"][0]["graph_revision"].as_i64());
    drop(stream);
    s.finish().await
}

#[tokio::test]
async fn wma_05_hold_decisions_survive_restart_and_resolve() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed {
        mut s, held_chat, ..
    } = seeded("WMA-05", "UPDATE wm_works SET scope_ref=(SELECT home_session_id FROM wm_works WHERE id='wk_queue'),chain_id='ch_queue',step_index=2,stack_position=0,run_state='held',hold_reason='predecessor_failed',held_by_work_id='wk_queue' WHERE id='wk_minutes'; INSERT INTO wm_work_edges VALUES('wk_queue_ui','wk_minutes','ch_queue');").await?;
    let q = queue(&s, &held_chat).await?;
    assert_eq!(
        step_ids(&q),
        vec![vec!["wk_queue"], vec!["wk_queue_ui"], vec!["wk_minutes"]]
    );
    assert_eq!(
        q["chains"][0]["hold_questions"].as_array().unwrap().len(),
        1
    );
    s.restart().await?;
    assert_eq!(queue(&s, &held_chat).await?, q);
    let released=data(edit_queue(&s,&held_chat,"ch_queue",&q["chains"][0]["graph_revision"],json!([{"op":"decide_hold","chain_id":"ch_queue","id":"hd_queue","decision":"run_anyway"}])).await?,200);
    assert_eq!(released["chains"][0]["hold_questions"], json!([]));
    assert_eq!(
        released["chains"][0]["steps"][1]["works"][0]["run_state"],
        "waiting"
    );
    assert_eq!(
        released["chains"][0]["ready_work_ids"],
        json!(["wk_queue_ui"])
    );
    assert_eq!(queue(&s, &held_chat).await?, released);
    let states: Vec<_> = released["chains"][0]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| step["works"][0]["run_state"].as_str().unwrap())
        .collect();
    assert_eq!(states, vec!["failed", "waiting", "waiting"]);
    // Runtime is not wired yet. Seed a genuine new failure transition while
    // stopped, then start again to answer the resulting fresh durable question.
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = db.transaction()?;
    let ctx = butler_work::store::Context {
        now: 10,
        actor: json!({"runtime":"test"}),
    };
    let old = butler_work::store::read_work(&tx, "wk_queue").unwrap();
    let running = butler_work::store::transition(
        &tx,
        &ctx,
        "wk_queue",
        old["revision"].as_i64().unwrap(),
        butler_work::work_types::RunState::Running,
        false,
        None,
    )
    .unwrap();
    butler_work::store::transition(
        &tx,
        &ctx,
        "wk_queue",
        running["revision"].as_i64().unwrap(),
        butler_work::work_types::RunState::Failed,
        false,
        Some("task_failed"),
    )
    .unwrap();
    tx.commit()?;
    drop(db);
    s.restart().await?;
    let fresh = queue(&s, &held_chat).await?;
    let questions = fresh["chains"][0]["hold_questions"].as_array().unwrap();
    assert_eq!(questions.len(), 1);
    assert_ne!(questions[0]["id"], "hd_queue");
    let deleted=data(edit_queue(&s,&held_chat,"ch_queue",&fresh["chains"][0]["graph_revision"],json!([{"op":"decide_hold","chain_id":"ch_queue","id":questions[0]["id"],"decision":"delete"}])).await?,200);
    assert_eq!(step_ids(&deleted), vec![vec!["wk_queue"]]);
    assert_eq!(deleted["chains"][0]["hold_questions"], json!([]));
    assert_eq!(queue(&s, &held_chat).await?, deleted);
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<String, _, _>(
            "SELECT run_state FROM wm_works WHERE id='wk_queue_ui'",
            [],
            |r| r.get(0)
        )?,
        "cancelled"
    );
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn wma_06_queue_delete_preserves_canon_membership_and_status() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Seed {
        s, project, chat, ..
    } = seeded(
        "WMA-06",
        "UPDATE wm_works SET run_state='waiting' WHERE id='wk_canon';",
    )
    .await?;
    let canon = overview(&s, &project).await?;
    let before = data(s.gw.get("/canon/epics/wk_canon").await?, 200);
    let q = queue(&s, &chat).await?;
    let deleted = data(
        edit_queue(
            &s,
            &chat,
            "ch_canon",
            &q["chains"][0]["graph_revision"],
            json!([{"op":"delete","chain_id":"ch_canon","work_id":"wk_canon"}]),
        )
        .await?,
        200,
    );
    assert_eq!(
        step_ids(&deleted),
        vec![vec!["wk_schema", "wk_store"], vec!["wk_api"]]
    );
    let after = data(s.gw.get("/canon/epics/wk_canon").await?, 200);
    assert_eq!(after["run_state"], "idle");
    assert_eq!(after["canon_status"], before["canon_status"]);
    assert_eq!(after["plan_id"], before["plan_id"]);
    assert!(after["chain_id"].is_null());
    let latest = overview(&s, &project).await?;
    assert_eq!(ids(&latest["backlog"]), ids(&canon["backlog"]));
    assert_eq!(
        ids(&latest["plans"][0]["works"]),
        ids(&canon["plans"][0]["works"])
    );
    assert_eq!(latest["plans"][0]["works"][0]["run_state"], "idle");
    s.finish().await
}
