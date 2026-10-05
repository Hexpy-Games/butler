//! Exercise dirty-key coalescing under the caller's upsert conflict policy.
use super::support;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use std::path::Path;

pub(super) fn coalesce(data: &Path) -> Result<(), HarnessError> {
    let mut db = butler_platform::sqlite::open(support::graph(data))?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let before: (String, String, String) = tx.query_row(
        "SELECT memory_chunk_id,current_revision,summary FROM memory_chunks WHERE source_key LIKE 'explicit_record:%' ORDER BY source_key LIMIT 1",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    // A single transaction prevents the background indexer draining the dirty
    // key between mutations. Rewriting identical values must retain one key.
    tx.execute(
        "UPDATE memory_chunks SET current_revision=current_revision WHERE memory_chunk_id=?1",
        [&before.0],
    )?;
    tx.execute("INSERT INTO memory_chunks SELECT * FROM memory_chunks WHERE memory_chunk_id=?1 ON CONFLICT(source_key) DO UPDATE SET current_revision=excluded.current_revision", [&before.0])?;
    let after: (String, String, String) = tx.query_row(
        "SELECT memory_chunk_id,current_revision,summary FROM memory_chunks WHERE memory_chunk_id=?1",
        [&before.0], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    assert_eq!(after, before);
    assert_eq!(
        tx.query_row(
            "SELECT COUNT(*) FROM memory_episode_fts_pending WHERE episode_id=?1",
            [&before.0],
            |row| row.get::<_, i64>(0)
        )?,
        1
    );
    tx.commit()?;
    Ok(())
}

pub(super) async fn upgrade(s: &mut Scenario) -> Result<(), HarnessError> {
    settled_sources(&s.sandbox.data).await?;
    s.agent.terminate().await?;
    let before = support::active_rules(&s.sandbox.data);
    let db = butler_platform::sqlite::open(support::graph(&s.sandbox.data))?;
    db.execute_batch("BEGIN IMMEDIATE; DROP TRIGGER fts_v1_memory_chunks_UPDATE; CREATE TRIGGER fts_v1_memory_chunks_UPDATE AFTER UPDATE ON memory_chunks BEGIN INSERT OR IGNORE INTO memory_episode_fts_pending SELECT OLD.memory_chunk_id UNION SELECT NEW.memory_chunk_id; END; DELETE FROM memory_state WHERE key='episode_fts_trigger_version'; COMMIT;")?;
    drop(db);
    s.restart().await?;
    support::until(|| {
        let db = rusqlite::Connection::open_with_flags(support::graph(&s.sandbox.data), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row("SELECT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_trigger_version' AND value='2')", [], |row| row.get::<_, bool>(0)).unwrap()
    }).await;
    assert_eq!(support::active_rules(&s.sandbox.data), before);
    coalesce(&s.sandbox.data)?;
    eprintln!(
        "FTS-PENDING outer_upsert_coalesced=true legacy_trigger_upgraded=true complete_rules_preserved={}",
        before.len()
    );
    Ok(())
}

/// A schema-upgrade restart follows completed extraction. Cancelling a live
/// provider has its own required terminal-failure contract; do not invoke it
/// accidentally while asserting that every window here remains error-free.
async fn settled_sources(data: &Path) -> Result<(), HarnessError> {
    let canonical = butler_platform::sqlite::open_with_flags(
        data.join("runtime/conversation-store.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let turns = canonical
        .prepare("SELECT turn_id FROM conversation_turn_outcomes ORDER BY turn_id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        turns.len(),
        2,
        "both instruction-capture turns must be durable"
    );
    drop(canonical);
    support::until(|| {
        let db = butler_platform::sqlite::open_with_flags(support::graph(data), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let errors = db.prepare("SELECT state,error_code FROM memory_projection_windows WHERE error_code IS NOT NULL ORDER BY state,error_code").unwrap().query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        assert!(errors.is_empty(), "migration setup must keep all extraction error-free: {errors:?}");
        let complete = turns.iter().all(|turn| db.query_row("SELECT EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.source_key=?1 AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.hot_cache_state,'$.state')='complete')", [format!("conversation_turn:{turn}")], |row| row.get::<_, bool>(0)).unwrap());
        complete && db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_projection_windows WHERE state IN ('pending','running','planned'))", [], |row| row.get::<_, bool>(0)).unwrap()
    }).await;
    eprintln!(
        "FTS-MIGRATION complete_canonical_sources={} active_extractors=0",
        turns.len()
    );
    Ok(())
}
