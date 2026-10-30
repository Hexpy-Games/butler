//! Scope and current revision precede ordered selection; canonical rejection refills.
use super::super::{db_error, recall::scope};
use crate::cognition::{CognitionResult, recall::RecallRequest};
use butler_core::search_text::analyze_recall_query;
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

/// Episodes one FTS selection returns.
const SELECTED: usize = 30;

/// The best [`SELECTED`] current episodes in BM25 order. `current` is the cheap
/// per-hit check; `verify` validates a batch of hits that would fill the
/// selection, so only selected hits are hydrated and rejected ones refill.
/// Either returns `None` at the deadline, which makes the selection partial.
pub(in crate::cognition::graph) fn select(
    db: &Connection,
    input: &RecallRequest,
    mut current: impl FnMut(&str, &str) -> CognitionResult<Option<bool>>,
    mut verify: impl FnMut(&[(String, String)]) -> CognitionResult<Option<Vec<bool>>>,
) -> CognitionResult<(Vec<String>, bool)> {
    if !ready(db)? {
        return Ok((Vec::new(), true));
    }
    let expression = analyze_recall_query(&input.cue);
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
    let mut batch = Vec::<(String, String)>::new();
    let mut exhausted = false;
    while ids.len() < SELECTED {
        if !exhausted && ids.len() + batch.len() < SELECTED {
            match rows.next().map_err(db_error)? {
                Some(row) => {
                    let id: String = row.get(0).map_err(db_error)?;
                    let refs: String = row.get(1).map_err(db_error)?;
                    match current(&id, &refs)? {
                        Some(true) => batch.push((id, refs)),
                        Some(false) => {}
                        None => {
                            partial = true;
                            exhausted = true;
                        }
                    }
                }
                None => exhausted = true,
            }
            continue;
        }
        if batch.is_empty() {
            break;
        }
        let Some(valid) = verify(&batch)? else {
            partial = true;
            break;
        };
        ids.extend(
            batch
                .drain(..)
                .zip(valid)
                .filter_map(|((id, _), valid)| valid.then_some(id)),
        );
    }
    Ok((ids, partial))
}
