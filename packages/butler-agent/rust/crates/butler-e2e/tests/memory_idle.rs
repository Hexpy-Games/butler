//! MEM-IDLE: a settled owner-scale memory graph does not write while idle.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

#[path = "support/memory_fixture.rs"]
mod memory_fixture;
use butler_platform::sqlite;
use memory_fixture::initialize_empty;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::stop_intent::{instance_record, read_intent};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

const COMPLETED_WINDOWS: usize = 30_000;
const IDLE: Duration = Duration::from_secs(60);

/// Completed windows exercise the idle indexes without starting model work.
fn seed_graph(path: &Path) {
    let mut db = sqlite::open(path).unwrap();
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
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn signature(path: &Path) -> Option<(u64, SystemTime)> {
    std::fs::metadata(path)
        .ok()
        .map(|meta| (meta.len(), meta.modified().unwrap()))
}

fn seed_imported_message(data: &Path) {
    let canonical = sqlite::open(data.join("runtime/conversation-store.sqlite")).unwrap();
    let now = "2026-09-29T00:00:00.000Z";
    canonical.execute("INSERT INTO conversation_sessions(id,gateway_origin,created_at,updated_at,status,schema_version) VALUES('idle-recovery-session','app',?1,?1,'active',4)", [now]).unwrap();
    canonical.execute("INSERT INTO conversation_messages(id,session_id,seq,role,status,visibility,provenance,created_at,origin_kind) VALUES('idle-recovery-message','idle-recovery-session',1,'user','complete','user','imported',?1,'user_input')", [now]).unwrap();
    canonical.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES('idle-recovery-part','idle-recovery-message',0,'text','{\"text\":\"Remember this recovery fact\"}','complete')", []).unwrap();
    canonical
        .execute(
            "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
            [],
        )
        .unwrap();
}

fn hide_registered_message(graph: &Path) {
    let graph = sqlite::open(graph).unwrap();
    let cursor: String = graph
        .query_row(
            "SELECT value FROM memory_state WHERE key='canonical_catchup_message_cursor'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cursor, "idle-recovery-message");
    graph.execute("UPDATE memory_projection_windows SET state='complete' WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j, json_each(j.observed_completion_job_ids) observed WHERE observed.value LIKE 'catchup:message:idle-recovery-message:%')", []).unwrap();
    graph.execute("UPDATE memory_projection_jobs SET observed_completion_job_ids='[]' WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j, json_each(j.observed_completion_job_ids) observed WHERE observed.value LIKE 'catchup:message:idle-recovery-message:%')", []).unwrap();
}

fn recovery_observations(graph: &Path) -> i64 {
    readonly(graph).query_row(
        "SELECT COUNT(*) FROM memory_projection_jobs j, json_each(j.observed_completion_job_ids) observed WHERE observed.value LIKE 'catchup:message:idle-recovery-message:%'",
        [], |row| row.get(0),
    ).unwrap()
}

fn catchup_message_cursor(graph: &Path) -> Option<String> {
    readonly(graph)
        .query_row(
            "SELECT value FROM memory_state WHERE key='canonical_catchup_message_cursor'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

async fn wait_for_catchup_message_cursor(graph: &Path, expected: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while catchup_message_cursor(graph).as_deref() != Some(expected) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "catch-up message cursor did not reach {expected}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::test]
async fn mem_idle_daily_cycle_and_crash_recovery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("MEM-IDLE-RECOVERY")?.fixture(Fixture::Empty);
    let graph = initialize_empty(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let graph_db = readonly(&graph);
    let before = data_version(&graph_db);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let daily_writes = data_version(&graph_db) - before;
    assert_eq!(daily_writes, 0, "idle daily graph writes");

    seed_imported_message(&s.sandbox.data);
    s.restart().await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while recovery_observations(&graph) == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        recovery_observations(&graph),
        1,
        "initial registration missing"
    );
    // Registration observations commit before the catch-up cursor is saved.
    wait_for_catchup_message_cursor(&graph, "idle-recovery-message").await;
    hide_registered_message(&graph);
    assert_eq!(
        recovery_observations(&graph),
        0,
        "observation was not removed"
    );
    s.agent.kill9()?;
    assert!(
        instance_record(&s.sandbox.data).is_some(),
        "crash marker missing"
    );
    assert!(
        read_intent(&s.sandbox.data).is_none(),
        "crash had stop intent"
    );
    s.gw = s.agent.start_again().await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while recovery_observations(&graph) == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        recovery_observations(&graph),
        1,
        "unclean startup missed the source"
    );
    tokio::time::sleep(Duration::from_secs(15)).await;
    let settled = data_version(&graph_db);
    tokio::time::sleep(Duration::from_secs(5)).await;
    let further_writes = data_version(&graph_db) - settled;
    eprintln!(
        "MEM-IDLE-RECOVERY daily_writes={daily_writes} recovery_observations=1 further_writes={further_writes}"
    );
    assert_eq!(further_writes, 0, "graph wrote after recovery settled");
    s.finish().await
}

#[tokio::test]
async fn mem_idle_has_no_graph_or_lock_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("MEM-IDLE")?.fixture(Fixture::Empty);
    let graph = initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
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
    let memory_workers_before = butler_platform::process_names::child_count(
        s.agent.pid().unwrap(),
        butler_platform::process_names::Role::Memory,
    )?;
    assert_eq!(memory_workers_before, 0);
    let idle_started = Instant::now();
    tokio::time::sleep(IDLE).await;
    let idle_window = idle_started.elapsed();
    let graph_commits = data_version(&graph_db) - before_graph_version;
    let leases = data_version(&lock_db) - before_lock_version;
    let graph_changed = signature(&graph) != before_graph;
    let wal_changed = signature(&PathBuf::from(format!("{}-wal", graph.display()))) != before_wal;
    let lock_changed = signature(&lock) != before_lock;
    let memory_workers = butler_platform::process_names::child_count(
        s.agent.pid().unwrap(),
        butler_platform::process_names::Role::Memory,
    )?;
    assert_eq!(memory_workers, 0);
    eprintln!(
        "MEM-IDLE memory_workers={memory_workers} idle_window={idle_window:?} graph_commits={graph_commits} graph_changed={graph_changed} wal_changed={wal_changed} lock_changed={lock_changed} leases={leases}"
    );
    assert_eq!(graph_commits, 0, "graph transactions during idle");
    assert!(
        !graph_changed && !wal_changed,
        "graph files changed during idle"
    );
    assert!(!lock_changed, "consolidation lock changed during idle");
    assert_eq!(leases, 0, "consolidation leases during idle");
    s.finish().await
}

#[tokio::test]
async fn mem_idle_catches_changed_source_without_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("MEM-IDLE-CHANGE")?.fixture(Fixture::Empty);
    let graph = initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    // Let the service's initial empty-source poll settle before changing it.
    // Memory maintenance is service-owned; the CLI no longer exposes it.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(recovery_observations(&graph), 0);
    seed_imported_message(&s.sandbox.data);
    // The source revision changes without restarting or notifying the consumer.
    let changed_at = tokio::time::Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(75);
    while catchup_message_cursor(&graph).as_deref() != Some("idle-recovery-message") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "changed source was not caught up"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(recovery_observations(&graph), 1);
    eprintln!(
        "MEM-IDLE-CHANGE catchup_ms={}",
        changed_at.elapsed().as_millis()
    );
    s.finish().await
}
