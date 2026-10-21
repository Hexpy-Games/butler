//! Pending sources can disappear or lose eligibility between registration and claim.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::coverage_seed::{published, recovered, session, turn};
use super::coverage_support::{canonical, drain, graph, hold_gate, release_gate, start};
use super::standalone_upgrade::reset_pending;
use butler_e2e::e2e::HarnessError;
use std::time::{Duration, Instant};

const GONE: &str = "orphan-source";
const KEPT: &str = "unrelated-source";
const AT: &str = "2026-03-10T00:00:00.000Z";

#[tokio::test]
async fn mem_orphaned_standalone_deleted() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    orphaned(true, false).await
}

#[tokio::test]
async fn mem_orphaned_turn_deleted() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    orphaned(false, false).await
}

#[tokio::test]
async fn mem_orphaned_standalone_ineligible_restored() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    orphaned(true, true).await
}

#[tokio::test]
async fn mem_orphaned_turn_ineligible_restored() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    orphaned(false, true).await
}

async fn orphaned(standalone: bool, ineligible: bool) -> Result<(), HarnessError> {
    let mut s = start("MEM-ORPHANED", &[]).await?;
    let data = s.sandbox.data.clone();
    crate::memory_wiring::bootstrap(&data).await;
    crate::memory_fixture::settle(&data).await?;
    for id in [GONE, KEPT] {
        session(&canonical(&data), id, None);
    }
    let source = if standalone {
        recovered(&canonical(&data), GONE, 1, "recovered source fact", AT);
        format!("conversation_message:{GONE}-recovered-1")
    } else {
        format!(
            "conversation_turn:{}",
            turn(&canonical(&data), GONE, 1, "turn source fact", AT)
        )
    };
    let kept_turn = turn(&canonical(&data), KEPT, 1, "unrelated turn fact", AT);
    recovered(&canonical(&data), KEPT, 10, "unrelated recovered fact", AT);
    drain(&data, &[]).await;
    // Do not reset jobs while their original hot-cache or FTS work is in flight.
    crate::memory_fixture::settle(&data).await?;
    // Recreate an upgraded graph's durable unprocessed queue under the lease.
    let gate = hold_gate(&data);
    let db = graph(&data);
    for key in [
        &source,
        &format!("conversation_turn:{kept_turn}"),
        &format!("conversation_message:{KEPT}-recovered-10"),
    ] {
        reset_pending(&db, key);
    }
    db.execute("UPDATE memory_projection_jobs SET created_at='2000-01-01T00:00:00Z' WHERE episode_id IN (SELECT memory_chunk_id FROM memory_chunks WHERE source_key=?1)", [&source]).unwrap();
    // External canonical writers also delete sources (e.g. restored history).
    // Park this revision without publishing new source content.
    let canonical = canonical(&data);
    if ineligible {
        let table = if standalone {
            "conversation_messages"
        } else {
            "conversation_turns"
        };
        let status = if standalone { "pending" } else { "running" };
        canonical
            .execute(
                &format!("UPDATE {table} SET status=?1 WHERE session_id=?2"),
                [status, GONE],
            )
            .unwrap();
    } else {
        canonical
            .execute("DELETE FROM conversation_sessions WHERE id=?1", [GONE])
            .unwrap();
    }
    release_gate(&gate);
    drop(gate);
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let due: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_windows WHERE state IN ('pending','planned','running')", [], |r| r.get(0)).unwrap();
            if due == 0 { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await;
    assert!(
        result.is_ok(),
        "queue stalled: {:?}; logs={}",
        super::coverage_support::incomplete_jobs(&data),
        s.agent.logs()
    );
    let (windows, terminal): (i64, i64) = db.query_row("SELECT COUNT(*),SUM(w.state='failed' AND w.next_attempt_at IS NULL AND w.owner_nonce IS NULL AND w.error_code LIKE 'memory_source_%') FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1", [&source], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert!(windows > 0);
    assert_eq!(terminal, windows, "orphaned windows must stop retrying");
    let complete: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.conversation_session_id=?1 AND w.state='complete'", [KEPT], |r| r.get(0)).unwrap();
    assert_eq!(complete, 3, "every unrelated window must complete");
    eprintln!(
        "MEM-ORPHANED standalone={standalone} ineligible={ineligible} drain_ms={} terminal={terminal} unrelated_complete={complete}",
        started.elapsed().as_millis()
    );
    drain(&data, &[GONE]).await;
    assert_idle(&s).await;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    drain(&data, &[GONE]).await;
    assert_idle(&s).await;
    if ineligible {
        let table = if standalone {
            "conversation_messages"
        } else {
            "conversation_turns"
        };
        canonical
            .execute(
                &format!("UPDATE {table} SET status='complete' WHERE session_id=?1"),
                [GONE],
            )
            .unwrap();
        published(&canonical);
        drain(&data, &[]).await;
        let completed: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND w.state='complete'", [&source], |r| r.get(0)).unwrap();
        assert_eq!(
            completed, windows,
            "catch-up must revive the same restored revision"
        );
        assert_idle(&s).await;
    }
    s.finish().await
}

async fn assert_idle(s: &butler_e2e::e2e::scenario::Scenario) {
    let db = graph(&s.sandbox.data);
    let version = || {
        db.pragma_query_value::<u64, _>(None, "data_version", |r| r.get(0))
            .unwrap()
    };
    let before = version();
    let errors = s.agent.logs().matches("[native-memory-sync]").count();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(version(), before, "idle graph writes");
    assert_eq!(
        s.agent.logs().matches("[native-memory-sync]").count(),
        errors,
        "repeated source poll errors"
    );
    eprintln!("MEM-ORPHANED idle_seconds=5 graph_writes=0 source_errors=0");
}
