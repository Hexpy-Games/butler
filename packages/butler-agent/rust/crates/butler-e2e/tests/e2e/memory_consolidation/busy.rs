use super::*;

async fn assert_busy(s: &Scenario) -> Result<(), HarnessError> {
    let id = uuid::Uuid::new_v4().to_string();
    let reply =
        s.gw.post("/memory/consolidation", json!({"operation_id":id}))
            .await?;
    assert_eq!(
        (reply.status, reply.error_code()),
        (409, Some("memory_operation_unavailable")),
        "{}",
        reply.text
    );
    assert!(
        !s.gw
            .events_since(0)
            .await?
            .iter()
            .any(|e| e["payload"]["operation_id"] == id)
    );
    Ok(())
}

#[tokio::test]
async fn consolidation_blocks_cleanup_and_every_reset() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _) = setup("MEM-CONSOLIDATION-BUSY").await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Notes"}),
        )
        .await?;
    assert_eq!(project.status, 201);
    let project = project.data()["project"]["id"].as_str().unwrap().to_owned();
    let held = s.provider()?.hold_next_reply("general_new_chat_briefing");
    assert_eq!(
        s.gw.post(
            "/memory/consolidation",
            json!({"operation_id":uuid::Uuid::new_v4()})
        )
        .await?
        .status,
        202
    );
    wait_calls(&s, 1).await;
    let revision = s.gw.get("/memory/inventory").await?.data()["revision"].clone();
    for path in [
        "/memory/cleanup".to_owned(),
        "/memory/reset/chat-memory".into(),
        "/memory/reset/profile".into(),
        format!("/memory/reset/projects/{project}"),
    ] {
        let id = uuid::Uuid::new_v4().to_string();
        let reply =
            s.gw.post(
                &path,
                json!({"operation_id":id,"inventory_revision":revision}),
            )
            .await?;
        assert_eq!(
            (reply.status, reply.error_code()),
            (409, Some("memory_operation_unavailable")),
            "{path}: {}",
            reply.text
        );
        assert!(
            !s.gw
                .events_since(0)
                .await?
                .iter()
                .any(|e| e["payload"]["operation_id"] == id)
        );
    }
    held.release();
    terminal(&s, "manual", "complete").await?;
    s.finish().await
}

#[tokio::test]
async fn another_writer_prevents_run_now_without_creating_an_operation() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, _) = setup("MEM-CONSOLIDATION-WRITER").await?;
    let lock = butler_platform::sqlite::open(
        s.sandbox
            .data
            .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )?;
    lock.execute_batch("BEGIN EXCLUSIVE")?;
    assert_busy(&s).await?;
    assert_eq!(calls(&s), 0);
    lock.execute_batch("ROLLBACK")?;
    s.finish().await
}

#[tokio::test]
async fn chat_reset_prevents_run_now() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _) = setup("MEM-CONSOLIDATION-RESET").await?;
    let graph = s
        .sandbox
        .data
        .join("cognition/memory/generations/00000000-0000-4000-8000-000000000222/graph.sqlite");
    // A populated graph gives reset real staging/pruning work while the next action arrives.
    let graph = butler_platform::sqlite::open(graph)?;
    graph.execute_batch("WITH RECURSIVE entries(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM entries WHERE n<511)
        INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at)
        SELECT printf('node-%d',n),'entity',printf('%065536d',n),'global','2026-10-02T03:00:00Z' FROM entries;")?;
    drop(graph);
    let measured = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(measured.status, 200, "{}", measured.text);
    let id = uuid::Uuid::new_v4().to_string();
    let reset =
        s.gw.post(
            "/memory/reset/chat-memory",
            json!({"operation_id":id,"inventory_revision":measured.data()["revision"]}),
        )
        .await?;
    assert_eq!(reset.status, 202, "{}", reset.text);
    assert_busy(&s).await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" {
                return Ok::<_, HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reset completed")?;
    s.finish().await
}

#[tokio::test]
async fn cleanup_prevents_run_now() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _) = setup("MEM-CONSOLIDATION-CLEANUP").await?;
    let generations = s.sandbox.data.join("cognition/memory/generations");
    // Actual reclaimable work keeps cleanup active while the second action arrives.
    for _ in 0..128 {
        let dir = generations.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir)?;
        for n in 0..32 {
            std::fs::write(dir.join(format!("part-{n}")), b"unused")?;
        }
    }
    let measured = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(measured.status, 200, "{}", measured.text);
    let id = uuid::Uuid::new_v4().to_string();
    let cleanup =
        s.gw.post(
            "/memory/cleanup",
            json!({"operation_id":id,"inventory_revision":measured.data()["revision"]}),
        )
        .await?;
    assert_eq!(cleanup.status, 202, "{}", cleanup.text);
    assert_busy(&s).await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/cleanup/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" {
                return Ok::<_, HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup completed")?;
    s.finish().await
}

#[tokio::test]
async fn scheduled_busy_skip_keeps_the_last_real_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("MEM-CONSOLIDATION-SKIP").await?;
    let previous = state(&s);
    let held = s.provider()?.hold_next_reply("general_new_chat_briefing");
    assert_eq!(
        s.gw.post(
            "/memory/consolidation",
            json!({"operation_id":uuid::Uuid::new_v4()})
        )
        .await?
        .status,
        202
    );
    wait_calls(&s, 1).await;
    clock(&address, "2026-10-02T04:00:00.000Z").await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while state(&s)["skipped"]["reason"] != "busy" {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("busy day skipped");
    let skipped = state(&s);
    assert_eq!(skipped["lastRunDate"], "2026-10-02");
    for key in ["lastRunAt", "status", "message"] {
        assert_eq!(skipped[key], previous[key]);
    }
    held.release();
    terminal(&s, "manual", "complete").await?;
    assert_eq!(state(&s)["lastRunDate"], "2026-10-02");
    assert_eq!(calls(&s), 1);
    s.finish().await
}

#[tokio::test]
async fn a_time_change_rearms_today_but_never_runs_immediately() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("MEM-CONSOLIDATION-REARM").await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"consolidation_time":"03:59"}))
            .await?
            .status,
        200
    );
    settled(&address).await?;
    assert_eq!(calls(&s), 0);
    assert_eq!(
        s.gw.patch("/settings", json!({"consolidation_time":"05:00"}))
            .await?
            .status,
        200
    );
    clock(&address, "2026-10-02T05:00:00.000Z").await?;
    terminal(&s, "scheduled", "complete").await?;
    assert_eq!(calls(&s), 1);
    assert_eq!(
        s.gw.patch("/settings", json!({"consolidation_time":"06:00"}))
            .await?
            .status,
        200
    );
    clock(&address, "2026-10-02T06:00:00.000Z").await?;
    completed_calls(&s, 2).await;
    assert_eq!(state(&s)["late"], false);
    s.finish().await
}
