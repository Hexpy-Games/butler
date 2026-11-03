//! Owner closeout is atomic and survives reopening the real storage owner.
use super::*;

#[tokio::test]
async fn tsk_06_terminal_work_and_card_close_active_and_pending_after_restart() -> Result {
    butler_e2e::gate!();
    for terminal in ["completed", "abandoned", "card", "delivered"] {
        let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-SCOPE")?;
        let (b, w) = setup(&dir.data).await?;
        assign(&b, &w, "active", task("price")).await?;
        let mut wait = task("price");
        wait["overlap"] = json!({"resolution":"wait","reason":"Serialize ownership"});
        assign(&b, &w, "pending", wait).await?;
        let work = w.view.work_id.clone();
        b.close().await?;
        let db = db(&dir.data)?;
        let tx = db.unchecked_transaction()?;
        if matches!(terminal, "card" | "delivered") {
            tx.execute(
                "UPDATE btcc_turns SET semantic_state=?2 WHERE turn_id=?1",
                rusqlite::params![
                    w.scope.turn_id,
                    if terminal == "card" {
                        "cancelled"
                    } else {
                        "delivered"
                    }
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE btcc_guided_works SET status=?2 WHERE work_id=?1",
                rusqlite::params![work, terminal],
            )?;
        }
        let open:i64=tx.query_row("SELECT count(*) FROM btcc_work_tasks WHERE work_id=?1 AND status IN ('pending','active')",[&work],|r|r.get(0))?;
        assert_eq!(open, 0, "must close inside the terminal transaction");
        tx.commit()?;
        drop(db);
        let b = GraphBuilder::open(&dir.data).await?;
        let tasks = b.children.repository().work_tasks(work).await?;
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|t| t.status
            == if matches!(terminal, "completed" | "delivered") {
                "done"
            } else {
                "cancelled"
            }));
        b.children.admit_waiting_workers().await?;
        assert!(
            b.children
                .repository()
                .work_tasks(w.view.work_id)
                .await?
                .iter()
                .all(|t| !matches!(t.status.as_str(), "active" | "pending"))
        );
        finish(b, dir).await?;
    }
    Ok(())
}

#[tokio::test]
async fn replacement_inherits_scope_and_supersedes_old_task() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-SCOPE")?;
    let (b, w) = setup(&dir.data).await?;
    let first = assign(&b, &w, "first", task("price")).await?;
    let mut replace = request(&w, "replacement", task("spec"));
    replace.replaces_relation_id = first["relation_id"].as_str().map(str::to_owned);
    assert_eq!(
        b.children.delegate_worker(replace.clone(), &w.view).await?["error"]["code"],
        "task_replacement_scope_mismatch"
    );
    replace.task = Some(serde_json::from_value(task("price"))?);
    let next = b.children.delegate_worker(replace, &w.view).await?;
    assert_eq!(next["ok"], true, "{next}");
    let tasks = b.children.repository().work_tasks(w.view.work_id).await?;
    assert_eq!(tasks[0].status, "superseded");
    assert_eq!(tasks[0].scope, tasks[1].scope);
    finish(b, dir).await
}

#[tokio::test]
async fn tsk_06_real_card_result_closes_tasks_before_restart() -> Result {
    butler_e2e::gate!();
    for status in ["success", "failed", "cancelled"] {
        let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-CARD")?;
        let (b, w) = setup(&dir.data).await?;
        assign(&b, &w, "active", task("price")).await?;
        let mut wait = task("price");
        wait["overlap"] = json!({"resolution":"wait","reason":"Keep one owner"});
        assign(&b, &w, "pending", wait).await?;
        b.children
            .complete_child(
                &w.scope.session_id,
                &w.scope.turn_id,
                status,
                "Terminal card".into(),
            )
            .await?;
        let tasks = b
            .children
            .repository()
            .work_tasks(w.view.work_id.clone())
            .await?;
        assert_eq!(tasks.len(), 2);
        assert!(
            tasks
                .iter()
                .all(|t| matches!(t.status.as_str(), "done" | "cancelled")),
            "{tasks:?}"
        );
        b.close().await?;
        let b = GraphBuilder::open(&dir.data).await?;
        let tasks = b.children.repository().work_tasks(w.view.work_id).await?;
        assert!(
            tasks
                .iter()
                .all(|t| matches!(t.status.as_str(), "done" | "cancelled"))
        );
        finish(b, dir).await?;
    }
    Ok(())
}

#[tokio::test]
async fn retained_direction_cannot_reopen_scope_held_by_another_task() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-DIRECTION")?;
    let (mut b, w) = setup(&dir.data).await?;
    let first = assign(&b, &w, "first", task("price")).await?;
    let worker = b
        .admit_child(
            first["child_session_id"].as_str().unwrap(),
            SessionRole::Worker,
        )
        .await?;
    b.result(&worker, "success", "Confirmed price").await?;
    let mut replacement = request(&w, "too late", task("price"));
    replacement.replaces_relation_id = first["relation_id"].as_str().map(str::to_owned);
    assert_eq!(
        b.children.delegate_worker(replacement, &w.view).await?["error"]["code"],
        "task_replacement_not_running"
    );
    let mut reuse = task("price");
    reuse["inputs"] = json!([{"task":first["task_id"],"use":"artifact"}]);
    let next = assign(&b, &w, "revise", reuse).await?;
    let refused = b
        .children
        .steer(SubsessionDirectionRequest {
            parent_session_id: w.scope.session_id,
            parent_turn_id: w.scope.turn_id.clone(),
            source_message_id: w.scope.turn_id,
            relation_id: first["relation_id"].as_str().map(str::to_owned),
            work_id: None,
            safe_title: None,
            instruction: "Revisit the same result".into(),
            immediate: false,
            child_role: butler_turn::workspace::SessionRole::Worker,
            access_mode: "full_access".into(),
            schedule_run: None,
        })
        .await?;
    assert_eq!(refused["error"]["code"], "task_scope_overlap");
    assert_eq!(
        refused["error"]["detail"]["overlaps"][0]["task"],
        next["task_id"]
    );
    finish(b, dir).await
}

#[tokio::test]
async fn replacement_transfers_pending_waiters_before_old_worker_settles() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-REPLACE-WAIT")?;
    let (mut b, w) = setup(&dir.data).await?;
    let first = assign(&b, &w, "first", task("price")).await?;
    let worker = b
        .admit_child(
            first["child_session_id"].as_str().unwrap(),
            SessionRole::Worker,
        )
        .await?;
    let mut wait = task("price");
    wait["overlap"] = json!({"resolution":"wait","reason":"Use the completed result"});
    let waiter = assign(&b, &w, "later", wait).await?;
    let mut replace = request(&w, "replacement", task("price"));
    replace.replaces_relation_id = first["relation_id"].as_str().map(str::to_owned);
    let replacement = b.children.delegate_worker(replace, &w.view).await?;
    assert_eq!(replacement["ok"], true, "{replacement}");
    b.result(&worker, "cancelled", "Superseded").await?;
    let tasks = b
        .children
        .repository()
        .work_tasks(w.view.work_id.clone())
        .await?;
    let pending = tasks
        .iter()
        .find(|t| t.task_id == waiter["task_id"])
        .unwrap();
    assert_eq!(pending.status, "pending");
    assert_eq!(
        pending.merge_after,
        vec![replacement["task_id"].as_str().unwrap()]
    );
    let next = b
        .admit_child(
            replacement["child_session_id"].as_str().unwrap(),
            SessionRole::Worker,
        )
        .await?;
    b.result(&next, "success", "Replacement confirmed result")
        .await?;
    let tasks = b.children.repository().work_tasks(w.view.work_id).await?;
    let admitted = tasks
        .iter()
        .find(|t| t.task_id == waiter["task_id"])
        .unwrap();
    assert_eq!(admitted.status, "active");
    assert_eq!(
        admitted.inputs[0].task,
        replacement["task_id"].as_str().unwrap()
    );
    finish(b, dir).await
}

#[tokio::test]
async fn pre_partition_storage_keeps_its_activation_receipt_and_plan() -> Result {
    butler_e2e::gate!();
    let dir = butler_e2e::e2e::sandbox::Sandbox::new("TASK-MIGRATION")?;
    let path = dir.data.join("agent-runtime/btcc.sqlite");
    let manifest = bootstrap_fresh_storage(
        &path,
        "isolated-migration",
        "test",
        "2026-11-03T00:00:00.000Z",
    )?;
    let mut b = GraphBuilder::open(&dir.data).await?;
    let w = b
        .graph("migration-owner", 1, "Preserve the existing plan")
        .await?;
    let plan = w
        .view
        .current_plan
        .as_ref()
        .unwrap()
        .plan_revision_id
        .clone();
    let original_objective = w.view.current_plan.as_ref().unwrap().objective.clone();
    b.close().await?;
    let connection = db(&dir.data)?;
    let triggers = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'work_task_%'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for name in triggers {
        connection.execute_batch(&format!("DROP TRIGGER {name}"))?;
    }
    connection.execute_batch("DROP TABLE btcc_work_task_waits; DROP TABLE btcc_work_tasks; ALTER TABLE btcc_guided_work_plan_revisions DROP COLUMN subjects_json;")?;
    let receipt: String = connection.query_row(
        "SELECT receipt_json FROM agent_storage_migration_receipt",
        [],
        |r| r.get(0),
    )?;
    drop(connection);
    assert_eq!(begin_storage_startup(&path, || {})?, manifest);
    let b = GraphBuilder::open(&dir.data).await?;
    let connection = db(&dir.data)?;
    let (objective,subjects):(String,String)=connection.query_row("SELECT objective,subjects_json FROM btcc_guided_work_plan_revisions WHERE plan_revision_id=?1",[plan],|r|Ok((r.get(0)?,r.get(1)?)))?;
    assert_eq!(objective, original_objective);
    assert_eq!(subjects, "[]");
    let unchanged: String = connection.query_row(
        "SELECT receipt_json FROM agent_storage_migration_receipt",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(unchanged, receipt);
    assert_eq!(begin_storage_startup(&path, || {})?, manifest);
    drop(connection);
    finish(b, dir).await
}
