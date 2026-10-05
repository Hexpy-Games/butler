//! Fixed empty generation for service startup and idle scenarios.
#![allow(clippy::unwrap_used, reason = "test fixture setup")]
use butler_e2e::e2e::HarnessError;
use butler_platform::sqlite;
use std::path::PathBuf;
#[path = "memory_fixture/settlement.rs"]
mod settlement;
pub(super) use settlement::settle;

pub(super) fn initialize_empty(data: &std::path::Path) -> Result<PathBuf, HarnessError> {
    let memory = data.join("cognition/memory");
    let root = memory.join("generations/00000000-0000-4000-8000-000000000222");
    std::fs::create_dir_all(&root)?;
    let graph = root.join("graph.sqlite");
    let db = sqlite::open(&graph).unwrap();
    db.execute_batch(include_str!("../../../fixtures/F-memory-empty/graph.sql"))
        .unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    drop(db);
    std::fs::write(
        root.join("manifest.json"),
        include_str!("../../../fixtures/F-memory-empty/manifest.json"),
    )?;
    std::fs::write(
        memory.join("active-generation.json"),
        include_str!("../../../fixtures/F-memory-empty/active-generation.json"),
    )?;
    initialize_coordinator(data)?;
    Ok(graph)
}

// Empty-generation initialization previously created this gate through the CLI.
// Seed its unbound schema; the service still owns fence binding and leases.
fn initialize_coordinator(data: &std::path::Path) -> Result<(), HarnessError> {
    let locks = data.join("cognition/consolidation/locks");
    std::fs::create_dir_all(&locks)?;
    let db = sqlite::open(locks.join("consolidation.lock.coord.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE memory_write_gate (
         singleton INTEGER PRIMARY KEY CHECK(singleton=1),
         format_version INTEGER NOT NULL, fence_sha256 TEXT, last_owner_json TEXT);
         INSERT INTO memory_write_gate VALUES(1,1,NULL,NULL);",
    )
    .unwrap();
    Ok(())
}
