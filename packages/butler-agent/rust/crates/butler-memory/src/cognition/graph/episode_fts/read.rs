//! Scope and current revision precede ordered selection; canonical rejection refills.
use super::{
    super::{db_error, recall::scope},
    tokenize,
};
use crate::cognition::{CognitionResult, MemoryGenerationHandle, recall::RecallRequest};
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};

pub(in crate::cognition::graph) fn ready(db: &Connection) -> CognitionResult<bool> {
    db.query_row(
        "SELECT 1 FROM sqlite_schema WHERE name='memory_episode_fts_meta'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(db_error)
}

pub(in crate::cognition::graph) fn compatible_vectors(
    db: &Connection,
    generation: &MemoryGenerationHandle,
) -> CognitionResult<bool> {
    let Some(embedding) = &generation.embedding else {
        return Ok(false);
    };
    db.query_row("SELECT 1 FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.state='complete' AND c.status='active' AND j.generation=?1 AND json_extract(u.receipt_json,'$.embedding_version')=?2 LIMIT 1", [generation.generation_id.as_str(),embedding.version()], |_| Ok(())).optional().map(|row| row.is_some()).map_err(db_error)
}

pub(in crate::cognition::graph) fn select(
    db: &Connection,
    input: &RecallRequest,
    mut current: impl FnMut(&str, &str) -> CognitionResult<Option<bool>>,
) -> CognitionResult<(Vec<String>, bool)> {
    if !ready(db)? {
        return Ok((Vec::new(), true));
    }
    let expression = tokenize::query(&input.cue);
    if expression.is_empty() {
        return Ok((Vec::new(), false));
    }
    let scope = scope::source(input, "s", "c");
    let pending = db.query_row(&format!("SELECT 1 FROM memory_episode_fts_pending p JOIN memory_chunks c ON c.memory_chunk_id=p.episode_id JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision WHERE {} LIMIT 1",scope.sql), params_from_iter(scope.args.iter()), |_| Ok(())).optional().map_err(db_error)?.is_some();
    let migrating = db
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_seeded') OR EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_cursor')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error)?;
    let mut partial = pending || migrating;
    let event = scope::event_episode(input, "c.memory_chunk_id");
    let sql = format!(
        "SELECT m.episode_id,m.source_refs_json FROM memory_episode_fts_v1 f JOIN memory_episode_fts_meta m ON m.id=f.rowid JOIN memory_chunks c ON c.memory_chunk_id=m.episode_id AND c.current_revision=m.revision WHERE memory_episode_fts_v1 MATCH ? AND c.status='active' AND NOT EXISTS(SELECT 1 FROM memory_episode_fts_pending p WHERE p.episode_id=m.episode_id) AND NOT EXISTS(SELECT 1 FROM json_each(m.source_refs_json) r LEFT JOIN memory_chunk_sources s ON s.source_id=r.value AND s.episode_id=m.episode_id AND s.revision=m.revision WHERE s.source_id IS NULL OR COALESCE(({}),0)=0) {} ORDER BY bm25(memory_episode_fts_v1,4,2,1,0.25),m.episode_id",
        scope.sql, event.sql
    );
    let mut args = vec![Value::Text(expression)];
    args.extend(scope.args);
    args.extend(event.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let mut rows = statement.query(params_from_iter(args)).map_err(db_error)?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next().map_err(db_error)? {
        let id: String = row.get(0).map_err(db_error)?;
        let refs: String = row.get(1).map_err(db_error)?;
        match current(&id, &refs)? {
            Some(true) => ids.push(id),
            Some(false) => {}
            None => {
                partial = true;
                break;
            }
        }
        if ids.len() == 30 {
            break;
        }
    }
    Ok((ids, partial))
}
