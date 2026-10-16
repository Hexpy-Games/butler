//! Ledger-owned plans and ordinary Turn effects use their real tool write paths.
use super::*;
use serde_json::json;

#[tokio::test]
async fn project_plan_effects_pass_scan_and_startup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BTCC-PROJECT-PLAN-EFFECTS")?.access(Access::FullAccess);
    fixtures::stub_codex_auth(&setup.sandbox.codex_home())?;
    let file = setup.sandbox.workspace.join("integrity.txt");
    let (url, server) = stub::start(file.display().to_string(), true, true).await?;
    let s = setup
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Integrity"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{}", project.text);
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind":"project",
        "project_id":project.data()["project"]["id"], "workspace_mode":"local"}),
        )
        .await?;
    assert_eq!(session.status, 201, "{}", session.text);
    let result = s
        .turn(
            session.data()["session"]["id"].as_str().unwrap(),
            stub::REQUEST,
        )
        .await;
    server.abort();
    let (_, turn) = result?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(std::fs::read_to_string(file)?, "beta");
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    let count: i64 = db.query_row("SELECT COUNT(*) FROM btcc_guided_effects e JOIN btcc_guided_works w ON w.work_id=e.work_id WHERE w.scope_kind='project' AND w.ledger_project_id IS NOT NULL AND w.current_plan_revision_id IS NULL AND e.plan_revision_id<>'' AND e.status='applied' AND e.capability IN ('write_file','edit_file')", [], |r| r.get(0))?;
    assert_eq!(
        count, 2,
        "real planned project effects must carry the Ledger revision"
    );
    let plans: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_guided_work_plan_revisions",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(plans, 0, "project plans are stored in the Ledger");
    drop(db);
    scan_and_startup(s).await
}

#[tokio::test]
async fn operation_turn_effects_use_general_empty_plan_rule() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BTCC-OPERATION-EFFECTS")?.access(Access::FullAccess);
    fixtures::stub_codex_auth(&setup.sandbox.codex_home())?;
    let file = setup.sandbox.workspace.join("integrity.txt");
    let (url, server) = stub::start(file.display().to_string(), false, false).await?;
    let s = setup
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    let result = s.turn("general", stub::REQUEST).await;
    server.abort();
    let (_, turn) = result?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(std::fs::read_to_string(file)?, "beta");
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: i64 = db.query_row("SELECT COUNT(*) FROM btcc_guided_effects WHERE work_id LIKE 'operation-turn:%' AND plan_revision_id='' AND status='applied'", [], |r| r.get(0))?;
    assert_eq!(count, 2);
    drop(db);
    scan_and_startup(s).await
}

async fn scan_and_startup(mut s: Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let before = snapshot(&path)?;
    std::fs::remove_file(path.with_extension("sqlite.verified"))?;
    s.gw = s.agent.start_again().await?;
    wait_scan(&s, &path).await?;
    assert!(!path.with_extension("sqlite.corrupt").exists());
    assert!(!path.with_extension("sqlite.findings").exists());
    s.agent.terminate().await?;
    std::fs::write(
        path.with_extension("sqlite.corrupt"),
        "agent_btcc_migration_reference_check_failed",
    )?;
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    assert!(!path.with_extension("sqlite.corrupt").exists());
    assert!(!path.with_extension("sqlite.findings").exists());
    assert_eq!(snapshot(&path)?, before);
    s.finish().await
}
