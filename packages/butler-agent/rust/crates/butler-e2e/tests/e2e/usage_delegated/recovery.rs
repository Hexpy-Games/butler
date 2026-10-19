//! Fault isolation and per-row auxiliary attribution through public reads.
use super::*;

#[tokio::test]
async fn relation_failure_retries_and_self_roots_refresh() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("usage-relation-recovery")?.start().await?;
    fixtures::append(
        &s.sandbox.data,
        &[
            fixtures::row(ROOT, None, None, 100, 20),
            fixtures::row("late-child", None, None, 200, 30),
        ],
    )?;
    // Cache the child's negative lookup before its relation is written.
    let first = s.gw.get("/usage-monitor?session_id=late-child").await?;
    fixtures::model(&first.data()["model"], 1, 200, 30);
    fixtures::relations(&s.sandbox.data, &[("late-child", ROOT, Some("worker"))])?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        "ALTER TABLE btcc_session_relations RENAME TO unavailable_relations",
        [],
    )?;
    for _ in 0..2 {
        let global = s.gw.get("/usage-monitor?since_hours=24").await?;
        fixtures::model(&global.data()["model"], 2, 300, 50);
        let session = s.gw.get("/session-view?session_id=general").await?;
        fixtures::session(&session.data()["usage"], 1, 100, 20);
    }
    db.execute(
        "ALTER TABLE unavailable_relations RENAME TO btcc_session_relations",
        [],
    )?;
    let recovered =
        s.gw.get("/usage-monitor?session_id=general&since_hours=24")
            .await?;
    fixtures::model(&recovered.data()["model"], 2, 300, 50);
    fixtures::model(&recovered.data()["model"]["byRole"]["worker"], 1, 200, 30);
    assert!(
        recovered.data()["topSessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["sessionId"] != "late-child")
    );
    let session = s.gw.get("/session-view?session_id=general").await?;
    fixtures::session(&session.data()["usage"], 2, 300, 50);
    s.finish().await
}

#[tokio::test]
async fn shared_auxiliary_scope_keeps_work_and_scope() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("usage-auxiliary-owners")?.start().await?;
    fixtures::auxiliary(&s.sandbox.data, ROOT, "worker", 100.0, 20.0)?;
    let created =
        s.gw.post("/sessions", serde_json::json!({"kind":"chat"}))
            .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let chat = created.data()["session"]["id"].as_str().unwrap();
    let runtime = created.data()["session"]["session_hint"].as_str().unwrap();
    fixtures::auxiliary(&s.sandbox.data, runtime, "steward", 200.0, 30.0)?;
    let lines = fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    for line in lines.lines() {
        let row: Value = serde_json::from_str(line)?;
        assert_eq!(row["scope"], "smart-search-planning");
        assert!(row["rootSessionId"].is_string());
        assert!(row["role"].is_string());
    }
    let view =
        s.gw.get("/usage-monitor?session_id=general&since_hours=24")
            .await?;
    fixtures::model(&view.data()["model"], 1, 100, 20);
    fixtures::model(&view.data()["model"]["byRole"]["worker"], 1, 100, 20);
    assert_eq!(view.data()["model"]["byScope"]["smart-search-planning"], 1);
    assert_eq!(
        view.data()["model"]["byScope"].as_object().unwrap().len(),
        1
    );
    assert_eq!(view.data()["cost"]["byWork"]["other"]["requestCount"], 1);
    let other =
        s.gw.get(&format!("/usage-monitor?session_id={chat}"))
            .await?;
    fixtures::model(&other.data()["model"], 1, 200, 30);
    let session = s.gw.get("/session-view?session_id=general").await?;
    fixtures::session(&session.data()["usage"], 1, 100, 20);
    s.finish().await
}

#[tokio::test]
async fn read_usage_tool_matches_lineage_view() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = butler_turn::btcc::TestStorageFixture::activated();
    let config = fixture.config("usage-tool");
    let db_path = config.path.clone();
    let storage = butler_turn::btcc::BtccStorage::open(config).await.unwrap();
    rusqlite::Connection::open(db_path)?.execute("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal) VALUES ('tool-link',?1,'turn','tool-child','message',0,'Task','now','worker','worker',1)", [ROOT])?;
    let repository = butler_turn::btcc::SqliteSubsessionRepository::new(storage.clone());
    let lineage = std::sync::Arc::new(butler_runtime::operations::UsageLineage::new(repository));
    let mut setup = Setup::new("usage-tool-lineage")?;
    fixtures::append(
        &setup.sandbox.data,
        &[
            fixtures::row(ROOT, Some(ROOT), Some("main"), 100, 20),
            fixtures::row("tool-child", None, None, 200, 30),
        ],
    )?;
    let value = butler_runtime::operations::read_usage_tool(
        &setup.sandbox.data,
        ROOT,
        None,
        lineage.clone(),
    )
    .await;
    fixtures::model(&value["model"], 2, 300, 50);
    fixtures::model(&value["model"]["byRole"]["worker"], 1, 200, 30);
    let monitor = butler_runtime::operations::UsageMonitor::with_owners(lineage.owners.clone());
    assert_eq!(
        monitor.read(&setup.sandbox.data, Some(ROOT), None, None)["model"],
        value["model"]
    );
    storage.close().await.unwrap();
    setup.sandbox.mark_success();
    Ok(())
}
