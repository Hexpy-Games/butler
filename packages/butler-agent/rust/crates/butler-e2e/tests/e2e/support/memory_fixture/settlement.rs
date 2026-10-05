//! A reset measures one settled generation, then submits once with that revision.
use butler_e2e::e2e::HarnessError;
use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{fs, path::Path, time::Duration};

pub(crate) async fn settle(data: &Path) -> Result<(), HarnessError> {
    let canonical = sqlite::open_with_flags(
        data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let turns = canonical
        .prepare("SELECT turn_id FROM conversation_turn_outcomes ORDER BY turn_id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(canonical);
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if settled(data, &turns)? {
                return Ok::<_, HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| HarnessError("memory work did not settle before reset measurement".into()))??;
    eprintln!(
        "MEMORY-RESET canonical_turns={} committed_projections=true fts_drained=true writer_released=true",
        turns.len()
    );
    Ok(())
}

fn settled(data: &Path, turns: &[String]) -> Result<bool, HarnessError> {
    let memory = data.join("cognition/memory");
    let active: Value = serde_json::from_slice(&fs::read(memory.join("active-generation.json"))?)?;
    let generation = active["generation_id"]
        .as_str()
        .ok_or_else(|| HarnessError("missing active generation".into()))?;
    let db = sqlite::open_with_flags(
        memory
            .join("generations")
            .join(generation)
            .join("graph.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let schema_ready: bool = db.query_row("SELECT COUNT(*)=6 FROM sqlite_schema WHERE type='table' AND name IN ('memory_projection_windows','memory_projection_jobs','memory_chunks','memory_vector_units','memory_state','memory_episode_fts_pending')", [], |row| row.get(0))?;
    if !schema_ready {
        return Ok(false);
    }
    let gate_path = data.join("cognition/consolidation/locks/consolidation.lock.coord.sqlite");
    if !turns_complete(&db, turns)? {
        return Ok(false);
    }
    let complete: bool = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_projection_windows WHERE state IN ('pending','running','planned')) AND NOT EXISTS(SELECT 1 FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE c.status='active' AND (json_extract(j.semantic_graph_state,'$.state') NOT IN ('complete','unsupported') OR json_extract(j.hot_cache_state,'$.state') NOT IN ('complete','not_configured'))) AND NOT EXISTS(SELECT 1 FROM memory_vector_units WHERE state='running') AND NOT EXISTS(SELECT 1 FROM memory_episode_fts_pending) AND NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_cursor') AND EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_seeded') AND EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_trigger_version' AND value='2')", [], |row| row.get(0))?;
    let captures = match fs::read_dir(memory.join("rules/captures")) {
        Ok(mut entries) => entries.next().transpose()?.is_none(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    // The production consumer treats an uncreated queue as empty.
    let queue_empty = match fs::read_to_string(memory.join("queue/sync.jsonl")) {
        Ok(queue) => queue.trim().is_empty(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    Ok(complete
        && captures
        && !memory.join("rules/pending.json").exists()
        && !gate_path
            .with_file_name("consolidation.lock.coord.sqlite-journal")
            .exists()
        && queue_empty)
}

fn turns_complete(db: &Connection, turns: &[String]) -> Result<bool, HarnessError> {
    let has_floor: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='memory_reset_admissions')",
        [],
        |row| row.get(0),
    )?;
    for turn in turns {
        // Prior reset exclusions are durable; waiting for those sources to
        // reappear would violate the reset's future-only contract.
        if has_floor
            && db.query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_reset_admissions WHERE kind='turn' AND id=?1)",
                [turn],
                |row| row.get::<_, bool>(0),
            )?
        {
            continue;
        }
        if !db.query_row("SELECT EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.source_key=?1 AND c.status='active' AND json_extract(j.semantic_graph_state,'$.state') IN ('complete','unsupported') AND json_extract(j.hot_cache_state,'$.state') IN ('complete','not_configured'))", [format!("conversation_turn:{turn}")], |row| row.get::<_, bool>(0))? {
            return Ok(false);
        }
    }
    Ok(true)
}
