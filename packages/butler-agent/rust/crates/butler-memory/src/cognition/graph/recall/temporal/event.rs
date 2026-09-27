//! Event-time bins use claim intervals but do not apply conversation-time range.

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{RecallRequest, RecallTime},
};

use super::super::{db_error, scope};

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    time: &RecallTime,
    from_ms: f64,
    duration: f64,
    bins: i64,
) -> CognitionResult<Vec<(String, Option<String>)>> {
    // scope::source excludes event-time clauses and retains the as-of source ceiling.
    let source = scope::source(input, "s", "c");
    let sql = format!(
        r"
      WITH event_claims AS (
        SELECT m.episode_id,
          CASE WHEN s.source_kind='conversation' THEN 'conversation:'||c.conversation_session_id
               ELSE s.source_kind||':'||c.memory_chunk_id END session_id,
          m.node_id,
          (SELECT valid_from FROM memory_claims WHERE node_id=e.id) basis_time,
          CASE (SELECT salience FROM memory_claims WHERE node_id=e.id)
            WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END salience,
          MIN(?-1,MAX(0,CAST((MAX(0,((julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))-2440587.5)*86400000)-?))*?/? AS INTEGER))) bin
        FROM memory_evidence m
        JOIN memory_nodes e ON e.id=m.node_id
        JOIN memory_chunk_sources s ON s.source_id=m.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE e.type IN ('preference','goal','constraint','decision','memory_atom')
          AND (SELECT valid_from FROM memory_claims WHERE node_id=e.id) IS NOT NULL
          AND julianday((SELECT valid_from FROM memory_claims WHERE node_id=e.id))<julianday(?)
          AND julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=e.id),?))>julianday(?)
          AND {}
      ), episodes AS (
        SELECT episode_id,session_id,bin,MAX(basis_time) basis_time,MAX(salience) salience
        FROM event_claims GROUP BY episode_id
      ), per_session AS (
        SELECT *,ROW_NUMBER() OVER(PARTITION BY bin,session_id ORDER BY salience DESC,basis_time DESC,episode_id) session_rank
        FROM episodes
      ), session_heads AS (
        SELECT bin,session_id,
          ROW_NUMBER() OVER(PARTITION BY bin ORDER BY salience DESC,basis_time DESC,episode_id,session_id) session_order
        FROM per_session WHERE session_rank=1
      ), bin_queue AS (
        SELECT p.*,ROW_NUMBER() OVER(PARTITION BY p.bin ORDER BY p.session_rank,h.session_order) bin_position
        FROM per_session p JOIN session_heads h ON h.bin=p.bin AND h.session_id=p.session_id
      )
      SELECT q.episode_id,(
        SELECT node_id FROM event_claims ec WHERE ec.episode_id=q.episode_id
        ORDER BY ec.salience DESC,ec.basis_time DESC,ec.node_id LIMIT 1
      ) node_id
      FROM bin_queue q WHERE q.bin_position<=8 ORDER BY q.bin_position,q.bin LIMIT 64
    ",
        source.sql
    );
    let mut args = vec![
        Value::Integer(bins),
        Value::Real(from_ms),
        Value::Integer(bins),
        Value::Real(duration),
        Value::Text(time.to.clone()),
        Value::Text(time.to.clone()),
        Value::Text(time.from.clone()),
    ];
    args.extend(source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}
