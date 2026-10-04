//! The judge fixture requires complete, equally indexed seed summaries.
use super::{HarnessError, Scenario, memory_stubs};
use butler_e2e::e2e::harness_error;
use rusqlite::OpenFlags;
use std::time::Duration;

pub(super) async fn prepare(s: &Scenario) -> Result<(), HarnessError> {
    // Include text projection and FTS in the original 90s fixture deadline.
    tokio::time::timeout(Duration::from_secs(90), async {
        memory_stubs::text_complete(&s.sandbox.data, 1).await?;
        let graph = memory_stubs::graph_path(&s.sandbox.data)?;
        let session = {
            let mut db = butler_platform::sqlite::open(&graph)?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let count = tx.execute(
                "UPDATE memory_chunks SET summary=?1,summary_status='complete'",
                ["Synthetic September activity 🙂".repeat(30)],
            )?;
            assert!(count >= 2, "judge fixture requires both seed episodes");
            tx.execute(
                "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
                [],
            )?;
            let session: String = tx.query_row("SELECT conversation_session_id FROM memory_chunks WHERE conversation_session_id IS NOT NULL LIMIT 1", [], |row| row.get(0))?;
            tx.commit()?;
            session
        };
        s.provider()?.add_placeholder("SEED_SESSION", session);
        // Direct SQL bypasses the source owner's committed-work signal.
        std::fs::write(graph.with_file_name("judge-fixture-committed"), b"committed")?;
        loop {
            let db = butler_platform::sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let (ready, indexed): (bool, i64) = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_episode_fts_pending) AND NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_cursor') AND (SELECT COUNT(*) FROM memory_episode_fts_meta m JOIN memory_chunks c ON c.memory_chunk_id=m.episode_id AND c.current_revision=m.revision WHERE c.status='active')=(SELECT COUNT(*) FROM memory_chunks WHERE status='active'), (SELECT COUNT(*) FROM memory_episode_fts_meta)", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            drop(db);
            if ready {
                assert!(indexed >= 2, "both complete candidates must be indexed");
                eprintln!("JUDGE-FIXTURE complete_indexed={indexed} pending=0");
                return Ok::<(), HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| harness_error("judge fixture text/FTS projection exceeded 90s"))?
}
