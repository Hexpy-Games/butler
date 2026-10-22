//! WMU-12: a static pre-p14 folder starts and upgrades without an action.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
mod ledger_fixture;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use rusqlite::Connection;
use serde_json::Value;
use std::{path::Path, time::Duration};

fn fixture(root: &Path, workspace: &Path) -> Result<(), HarnessError> {
    let btcc = root.join("agent-runtime/btcc.sqlite");
    butler_turn::btcc::bootstrap_fresh_storage(&btcc, "fixture", "pre-p14", "2026-10-01T00:00:00Z")
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    let db = Connection::open(btcc)?;
    // The unreleased target schema is absent in a pre-p14 data folder. Legacy
    // rows and the deployed BTCC activation receipt are the fixture's sources.
    let triggers = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'wm_*'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for name in triggers {
        db.execute_batch(&format!("DROP TRIGGER {name}"))?;
    }
    let tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'wm_*'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for name in tables {
        db.execute_batch(&format!("DROP TABLE {name}"))?;
    }
    db.execute_batch(include_str!("../../fixtures/work-model-cutover/btcc.sql"))?;
    drop(db);
    std::fs::create_dir_all(root.join("app-server"))?;
    let app = Connection::open(root.join("app-server/butler-client.sqlite"))?;
    app.execute_batch(include_str!("../../fixtures/work-model-cutover/app.sql"))?;
    app.execute(
        "UPDATE projects SET workspace_path=?1 WHERE id='legacy-project'",
        [workspace.to_string_lossy().as_ref()],
    )?;
    for (id, body) in [
        (
            "ledger-only",
            include_str!("../../fixtures/work-model-cutover/work.md"),
        ),
        (
            "unreadable",
            include_str!("../../fixtures/work-model-cutover/unreadable.md"),
        ),
    ] {
        let directory = root
            .join("project-ledger/projects/legacy-ledger/work")
            .join(id);
        std::fs::create_dir_all(&directory)?;
        std::fs::write(directory.join("work.md"), body)?;
    }
    ledger_fixture::install(root)?;
    Ok(())
}
pub(super) async fn completed(s: &Scenario) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let reply = s.gw.get("/work-model/cutover").await?;
            assert_eq!(reply.status, 200, "{}", reply.text);
            if reply.data()["state"] == "done" {
                return Ok::<_, HarnessError>(reply.data().clone());
            }
            // Wait for externally observable state; no synthetic fault or timing
            // assertion is involved in this startup user flow.
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| butler_e2e::e2e::harness_error("cutover did not finish"))?
}
fn rows(db: &Connection, sql: &str) -> Result<Vec<String>, HarnessError> {
    Ok(db
        .prepare(sql)?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}
#[tokio::test]
async fn wmu_12_automatic_upgrade_is_private_idle_and_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WMU-12")?;
    fixture(&setup.sandbox.data, &setup.sandbox.workspace)?;
    let mut s = setup.start().await?;
    let status = completed(&s).await?;
    assert!(
        status["needs_source"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "unreadable")
    );
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let ids = rows(&db, "SELECT id FROM wm_works ORDER BY id")?;
    assert_eq!(ids.len(), 4);
    assert_eq!(
        rows(
            &db,
            "SELECT id FROM wm_works WHERE visibility!='private' OR origin!='migration'"
        )?
        .len(),
        0
    );
    assert_eq!(
        rows(&db, "SELECT id FROM wm_works WHERE run_state='idle'")?.len(),
        3
    );
    assert_eq!(
        rows(
            &db,
            "SELECT id FROM wm_tasks WHERE status IN ('running','in_review')"
        )?
        .len(),
        0
    );
    assert_eq!(
        rows(
            &db,
            "SELECT id FROM wm_tasks WHERE historical=1 AND status='completed'"
        )?
        .len(),
        2
    );
    assert_eq!(rows(&db, "SELECT id FROM wm_task_parts")?.len(), 4);
    assert_eq!(rows(&db, "SELECT pred FROM wm_task_part_edges")?.len(), 3);
    assert_eq!(rows(&db,"SELECT id FROM wm_instructions WHERE id='legacy-direction' AND anchor_id='legacy-child-turn'")?.len(),1);
    let chain_steps = rows(
        &db,
        "SELECT cast(t.step_index AS TEXT) FROM wm_tasks t JOIN wm_works w ON w.id=t.work_id WHERE w.title='Prepare a garden' ORDER BY t.step_index,t.stack_position",
    )?;
    assert_eq!(chain_steps, vec!["0", "1", "1", "2"]);
    let task_ids = rows(&db, "SELECT id FROM wm_tasks ORDER BY id")?;
    let migration: String = db.query_row(
        "SELECT source_counts_json FROM wm_migration WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    drop(db);
    let backups = s.sandbox.data.join("backups/work-model-cutover");
    let sets = std::fs::read_dir(&backups)?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(sets.len(), 1);
    assert!(butler_work::cutover::valid(&sets[0])?);
    let manifest: Value = serde_json::from_slice(&std::fs::read(sets[0].join("manifest.json"))?)?;
    assert_eq!(manifest["files"].as_array().unwrap().len(), 2);
    s.gw = s.agent.restart().await?;
    assert_eq!(completed(&s).await?, status);
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(rows(&db, "SELECT id FROM wm_works ORDER BY id")?, ids);
    assert_eq!(rows(&db, "SELECT id FROM wm_tasks ORDER BY id")?, task_ids);
    assert_eq!(
        db.query_row::<String, _, _>(
            "SELECT source_counts_json FROM wm_migration WHERE singleton=1",
            [],
            |r| r.get(0)
        )?,
        migration
    );
    assert_eq!(std::fs::read_dir(backups)?.count(), 1);
    s.finish().await
}
#[tokio::test]
async fn newer_writer_epoch_refuses_startup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WMU-EPOCH")?;
    fixture(&setup.sandbox.data, &setup.sandbox.workspace)?;
    let mut s = setup.start().await?;
    completed(&s).await?;
    s.agent.terminate().await?;
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        "UPDATE wm_migration SET writer_epoch=?1 WHERE singleton=1",
        [butler_work::cutover::WRITER_EPOCH + 1],
    )?;
    drop(db);
    let result = s.agent.start_again().await;
    assert!(result.is_err());
    assert!(s.agent.logs().contains("newer Butler"));
    s.finish().await
}
