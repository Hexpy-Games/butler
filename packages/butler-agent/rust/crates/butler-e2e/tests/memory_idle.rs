//! MEM-IDLE: a settled owner-scale memory graph does not write while idle.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;
use rusqlite::{Connection, OpenFlags, params};

const COMPLETED_WINDOWS: usize = 30_000;
const IDLE: Duration = Duration::from_secs(60);

fn graph_path(data: &Path) -> Result<PathBuf, HarnessError> {
    let root = data.join("cognition/memory");
    let descriptor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("active-generation.json"))?)?;
    let generation = descriptor["generation_id"].as_str().unwrap();
    Ok(root
        .join("generations")
        .join(generation)
        .join("graph.sqlite"))
}

/// Completed windows exercise the idle indexes without starting model work.
fn seed_graph(path: &Path) {
    let mut db = Connection::open(path).unwrap();
    let tx = db.transaction().unwrap();
    {
        let mut job = tx.prepare_cached("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES(?1,?1,'1','v3','synthetic','stub','low','[]','complete','complete','complete','complete','complete','2026-01-01T00:00:00Z')").unwrap();
        let mut window = tx.prepare_cached("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state) VALUES(?1,?2,0,'[]','complete')").unwrap();
        for index in 0..COMPLETED_WINDOWS {
            let id = format!("idle-{index:05}");
            job.execute([&id]).unwrap();
            window
                .execute(params![format!("window-{index:05}"), id])
                .unwrap();
        }
    }
    tx.commit().unwrap();
}

fn data_version(db: &Connection) -> u64 {
    db.pragma_query_value(None, "data_version", |row| row.get(0))
        .unwrap()
}

fn readonly(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn signature(path: &Path) -> Option<(u64, SystemTime)> {
    std::fs::metadata(path)
        .ok()
        .map(|meta| (meta.len(), meta.modified().unwrap()))
}

#[tokio::test]
async fn mem_idle_has_no_graph_or_lock_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("MEM-IDLE")?.start().await?;
    let init = s
        .agent
        .cli_async(&[
            "cognition",
            "memory",
            "rebuild",
            "initialize-empty",
            "--json",
        ])
        .await?
        .json()?;
    assert_eq!(init["ok"], true, "{init}");
    let graph = graph_path(&s.sandbox.data)?;
    seed_graph(&graph);

    // Give the service time to discover the generation and finish its first sweep.
    tokio::time::sleep(Duration::from_secs(10)).await;
    let lock = s
        .sandbox
        .data
        .join("cognition/consolidation/locks/consolidation.lock");
    let coordinator = PathBuf::from(format!("{}.coord.sqlite", lock.display()));
    let graph_db = readonly(&graph);
    let lock_db = readonly(&coordinator);
    let before_graph_version = data_version(&graph_db);
    let before_lock_version = data_version(&lock_db);
    let before_graph = signature(&graph);
    let before_wal = signature(&PathBuf::from(format!("{}-wal", graph.display())));
    let before_lock = signature(&lock);
    tokio::time::sleep(IDLE).await;
    let graph_commits = data_version(&graph_db) - before_graph_version;
    let leases = data_version(&lock_db) - before_lock_version;
    let graph_changed = signature(&graph) != before_graph;
    let wal_changed = signature(&PathBuf::from(format!("{}-wal", graph.display()))) != before_wal;
    let lock_changed = signature(&lock) != before_lock;
    eprintln!(
        "MEM-IDLE graph_commits={graph_commits} graph_changed={graph_changed} wal_changed={wal_changed} lock_changed={lock_changed} leases={leases}"
    );
    assert_eq!(graph_commits, 0, "graph transactions during idle");
    assert!(
        !graph_changed && !wal_changed,
        "graph files changed during idle"
    );
    assert!(!lock_changed, "consolidation lock changed during idle");
    assert!(leases <= 2, "too many idle leases: {leases}");
    s.finish().await
}
