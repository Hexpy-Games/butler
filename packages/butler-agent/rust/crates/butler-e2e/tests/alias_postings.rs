//! Compact migration through the real leased service, using bundled SQLite.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "support/alias_fixture.rs"]
mod alias_fixture;
#[path = "support/alias_queries.rs"]
mod alias_queries;
#[path = "support/memory_fixture.rs"]
mod memory_fixture;
#[allow(
    dead_code,
    reason = "reuse the extraction fixture without its vector wait helper"
)]
#[path = "memory/stubs.rs"]
mod memory_stubs;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup},
};
use rusqlite::{Connection, OptionalExtension};
use std::time::{Duration, Instant};

fn state(db: &Connection) -> Option<String> {
    db.query_row(
        "SELECT value FROM memory_state WHERE key='alias_postings_v2'",
        [],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
}
fn count(db: &Connection) -> i64 {
    if state(db).is_none() {
        return 0;
    }
    db.query_row("SELECT COUNT(*) FROM memory_alias_documents", [], |r| {
        r.get(0)
    })
    .unwrap()
}

#[tokio::test]
async fn alias_owner_scale_copy_resume_equivalence_and_idle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = butler_e2e::e2e::nonce();
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("MEM-01")?;
    memory_stubs::extraction(&mut cassette, "")?;
    let setup = Setup::new("ALIAS-OWNER")?
        .fixture(Fixture::Ready)
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let seed = graph.clone();
    tokio::task::spawn_blocking(move || alias_fixture::legacy(&seed))
        .await
        .unwrap();
    let db = Connection::open(&graph).unwrap();
    eprintln!(
        "ALIAS-PHASE before sqlite={}",
        db.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))
            .unwrap()
    );
    let before = alias_queries::hashes(&db, "memory_alias_postings", false);
    let mut s = setup.start().await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(state(&db).is_none(), "migration enabled by default");
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_ALIAS_POSTINGS_V2", "1");
    s.agent.launch.set_env("BUTLER_E2E_ALIAS_BATCH_HOLD", "1");
    s.gw = s.agent.start_again().await?;
    let held = graph.with_extension("alias-batch-held");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !held.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("batch kill point never reached");
    assert!(s.gw.healthy().await, "copy blocked readiness");
    let stop = Instant::now();
    s.agent.terminate().await?;
    eprintln!("ALIAS uncommitted_shutdown_wall={:?}", stop.elapsed());
    butler_e2e::assert_wall_clock_budget!(
        stop.elapsed(),
        Duration::from_secs(6),
        "alias uncommitted batch shutdown"
    );
    assert!(
        state(&db).is_none(),
        "cancelled installation transaction committed"
    );
    let docs: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='memory_alias_documents')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!docs, "cancel failed to roll back dictionary DDL");
    s.agent.launch.set_env("BUTLER_E2E_ALIAS_BATCH_HOLD", "0");
    let started = Instant::now();
    let copy_deadline = started + Duration::from_secs(90);
    s.gw = s.agent.start_again().await?;
    // Pin a real recall snapshot for five seconds while copying proceeds.
    let pinned = Connection::open(&graph).unwrap();
    pinned
        .execute_batch("BEGIN; SELECT COUNT(*) FROM memory_aliases")
        .unwrap();
    let pin_start = Instant::now();
    let mut peak = 0;
    let wal = graph.with_file_name("graph.sqlite-wal");
    while pin_start.elapsed() < Duration::from_secs(5) {
        peak = peak.max(std::fs::metadata(&wal).map_or(0, |m| m.len()));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    pinned.execute_batch("ROLLBACK").unwrap();
    assert!(peak < 16 * 1024 * 1024, "pinned WAL peak {peak}");
    for boundary in [128, 1024, 4096] {
        while count(&db) < boundary && state(&db).as_deref() != Some("complete") {
            assert!(
                Instant::now() < copy_deadline,
                "copy stalled: {}",
                s.agent.logs()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        if boundary == 1024 {
            let apply = Instant::now();
            let (_, turn) = s.turn("general", &format!("Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {code}. Use your explicit memory tool, then confirm in one short sentence.")).await?;
            assert_eq!(butler_e2e::e2e::gateway::turn_state(&turn), "delivered");
            tokio::time::timeout(Duration::from_secs(6), async {
                loop {
                    let committed: i64 = db
                        .query_row("SELECT COUNT(*) FROM memory_meaning_commits", [], |r| {
                            r.get(0)
                        })
                        .unwrap();
                    if committed > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("foreground meaning apply did not commit during backfill");
            assert_eq!(
                state(&db).as_deref(),
                Some("copy"),
                "foreground apply missed backfill"
            );
            eprintln!("ALIAS foreground_apply_wall={:?}", apply.elapsed());
            butler_e2e::assert_wall_clock_budget!(
                apply.elapsed(),
                Duration::from_secs(6),
                "complete foreground turn and graph apply during copy"
            );
        }
        let gate = Connection::open(
            s.sandbox
                .data
                .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
        )
        .unwrap();
        alias_fixture::hold_gate(&gate);
        assert_eq!(
            state(&db).as_deref(),
            Some("copy"),
            "kill point missed copy stage"
        );
        if boundary == 4096 {
            eprintln!("ALIAS-PHASE during");
            assert_eq!(
                alias_queries::hashes(&db, "memory_alias_read_postings", false),
                before
            );
        }
        if boundary == 128 {
            // A queued background batch must not extend graceful shutdown.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let stop = Instant::now();
            let committed = count(&db);
            s.agent.terminate().await?;
            eprintln!("ALIAS queued_shutdown_wall={:?}", stop.elapsed());
            butler_e2e::assert_wall_clock_budget!(
                stop.elapsed(),
                Duration::from_secs(6),
                "alias queued batch shutdown"
            );
            assert_eq!(count(&db), committed, "queued batch committed after stop");
            gate.execute_batch("ROLLBACK").unwrap();
            s.gw = s.agent.start_again().await?;
            // Then crash the next running batch and verify restart integrity.
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        s.agent.kill9()?;
        if boundary != 128 {
            gate.execute_batch("ROLLBACK").unwrap();
        }
        // Check every migration write target at each crash. The immutable
        // 1.3-GiB legacy indexes get their full integrity check once below.
        for table in [
            "memory_alias_documents",
            "memory_alias_grams",
            "memory_state",
        ] {
            assert_eq!(
                db.query_row(&format!("PRAGMA integrity_check('{table}')"), [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                "ok"
            );
        }
        s.gw = s.agent.start_again().await?;
    }
    while state(&db).as_deref() != Some("complete") {
        assert!(
            Instant::now() < copy_deadline,
            "copy stalled: {}",
            s.agent.logs()
        );
        peak = peak.max(std::fs::metadata(&wal).map_or(0, |m| m.len()));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let wall = started.elapsed();
    let integrity = Instant::now();
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    eprintln!("ALIAS full_graph_integrity_wall={:?}", integrity.elapsed());
    assert_eq!(count(&db), 16561);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM memory_alias_grams", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        886_340
    );
    eprintln!("ALIAS-PHASE after");
    assert_eq!(
        alias_queries::hashes(&db, "memory_alias_read_postings", true),
        before
    );
    assert_eq!(
        alias_queries::hashes(&db, "memory_alias_postings", false),
        before
    );
    butler_e2e::assert_wall_clock_budget!(
        wall,
        Duration::from_secs(90),
        "alias migration with pinned reader and three crashes"
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let version: i64 = db
        .pragma_query_value(None, "data_version", |r| r.get(0))
        .unwrap();
    let idle_stages = s.agent.logs().matches("copy_lease_ms=").count();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(
        s.agent.logs().matches("copy_lease_ms=").count(),
        idle_stages,
        "completed worker performed another read/write stage"
    );
    assert_eq!(
        db.pragma_query_value::<i64, _>(None, "data_version", |r| r.get(0))
            .unwrap(),
        version
    );
    // A current-writer v1 read rollback keeps both shapes and blocks reclaim.
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_ALIAS_POSTINGS_READ_V1", "1");
    s.agent.launch.set_env("BUTLER_ALIAS_POSTINGS_RECLAIM", "1");
    s.gw = s.agent.start_again().await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(state(&db).as_deref(), Some("complete"));
    let descriptor_now: serde_json::Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join("cognition/memory/active-generation.json"),
    )?)?;
    assert!(
        descriptor_now["storage_generation_id"].is_null(),
        "reclaim ignored v1 read rollback"
    );
    assert_eq!(
        alias_queries::hashes(&db, "memory_alias_postings", false),
        before
    );
    s.agent.launch.set_env("BUTLER_ALIAS_POSTINGS_READ_V1", "0");
    // Closing the rollback window is a separate explicit request.
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_ALIAS_POSTINGS_RECLAIM", "1");
    let reclaim_start = Instant::now();
    let reclaim_deadline = reclaim_start + Duration::from_secs(30);
    s.gw = s.agent.start_again().await?;
    let descriptor = s
        .sandbox
        .data
        .join("cognition/memory/active-generation.json");
    let storage_id = loop {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&descriptor)?).unwrap();
        if let Some(id) = value["storage_generation_id"].as_str() {
            break id.to_owned();
        }
        assert!(
            Instant::now() < reclaim_deadline,
            "reclaim stalled: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let compact_path = s
        .sandbox
        .data
        .join("cognition/memory/generations")
        .join(format!(".storage-{storage_id}/graph.sqlite"));
    let compact = Connection::open(&compact_path).unwrap();
    assert_eq!(
        alias_queries::hashes(&compact, "memory_alias_postings", true),
        before
    );
    assert_eq!(count(&compact), 16561);
    let bytes = std::fs::metadata(&compact_path)?.len();
    let old_bytes = std::fs::metadata(&graph)?.len();
    assert!(bytes < old_bytes / 4, "reclaim failed: {bytes}/{old_bytes}");
    butler_e2e::assert_wall_clock_budget!(
        reclaim_start.elapsed(),
        Duration::from_secs(30),
        "alias separate reclaim"
    );
    let reclaim_wall = reclaim_start.elapsed();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let idle_version: i64 = compact
        .pragma_query_value(None, "data_version", |r| r.get(0))
        .unwrap();
    let idle_reclaims = s.agent.logs().matches("[alias-reclaim]").count();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(
        compact
            .pragma_query_value::<i64, _>(None, "data_version", |r| r.get(0))
            .unwrap(),
        idle_version
    );
    assert_eq!(
        s.agent.logs().matches("[alias-reclaim]").count(),
        idle_reclaims,
        "reclaimed worker continued reading"
    );
    eprintln!("ALIAS-RECLAIM wall={reclaim_wall:?} bytes={bytes} old_bytes={old_bytes}");
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        alias_queries::hashes(&compact, "memory_alias_postings", true),
        before
    );
    let stop = Instant::now();
    s.agent.terminate().await?;
    butler_e2e::assert_wall_clock_budget!(
        stop.elapsed(),
        Duration::from_secs(6),
        "alias migration stop"
    );
    eprintln!(
        "ALIAS-OWNER migration={wall:?} wal_peak_bytes={peak} docs=16561 grams=886_340 idle_commits=0 idle_copy_stages=0 idle_reclaim_stages=0"
    );
    let logs = s.agent.logs();
    for metric in [
        "batch_ms=",
        "copy_lease_ms=",
        "drop_lease_ms=",
        "vacuum_cutover_lease_ms=",
    ] {
        let values: Vec<u64> = logs
            .lines()
            .filter_map(|line| {
                line.split_once(metric)
                    .and_then(|(_, value)| value.split_whitespace().next()?.parse().ok())
            })
            .collect();
        eprintln!(
            "ALIAS-STAGE {metric} samples={} max={:?}",
            values.len(),
            values.iter().max()
        );
    }
    s.finish().await
}
