//! Conversation-time bins preserve the source's per-session distribution.

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{CognitionResult, recall::RecallRequest};

use super::super::{db_error, scope};

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    from_ms: f64,
    duration: f64,
    bins: i64,
) -> CognitionResult<Vec<(String, Option<String>)>> {
    let source = scope::source(input, "s", "c");
    let selected_source = scope::source(input, "s2", "c2");
    let claim = scope::claim(input, "e", "id");
    let selected_claim = scope::claim(input, "e2", "id");
    let sql = format!(
        r"
      WITH source_episodes AS (
        SELECT c.memory_chunk_id episode_id,
          CASE WHEN s.source_kind='conversation' THEN 'conversation:'||c.conversation_session_id
               ELSE s.source_kind||':'||c.memory_chunk_id END session_id,
          strftime('%Y-%m-%dT%H:%M:%fZ',MAX(julianday(s.observed_at))) basis_time,
          MAX(CASE (SELECT salience FROM memory_claims WHERE node_id=e.id)
              WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END) salience
        FROM memory_chunks c
        JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision
        LEFT JOIN memory_evidence m ON m.source_id=s.source_id AND m.revision=c.current_revision
        LEFT JOIN memory_nodes e ON e.id=m.node_id
          AND e.type IN ('preference','goal','constraint','decision','memory_atom')
        WHERE {} GROUP BY c.memory_chunk_id
        HAVING COUNT(DISTINCT e.id)=0 OR COUNT(DISTINCT CASE WHEN {} THEN e.id END)>0
      ), eligible AS (
        SELECT *,MIN(?-1,MAX(0,CAST((((julianday(basis_time)-2440587.5)*86400000)-?)*?/? AS INTEGER))) bin
        FROM source_episodes
      ), per_session AS (
        SELECT *,ROW_NUMBER() OVER(PARTITION BY bin,session_id ORDER BY salience DESC,basis_time DESC,episode_id) session_rank
        FROM eligible
      ), session_heads AS (
        SELECT bin,session_id,salience,basis_time,episode_id,
          ROW_NUMBER() OVER(PARTITION BY bin ORDER BY salience DESC,basis_time DESC,episode_id,session_id) session_order
        FROM per_session WHERE session_rank=1
      ), bin_queue AS (
        SELECT p.*,h.session_order,ROW_NUMBER() OVER(PARTITION BY p.bin ORDER BY p.session_rank,h.session_order) bin_position
        FROM per_session p JOIN session_heads h ON h.bin=p.bin AND h.session_id=p.session_id
      )
      SELECT q.episode_id,(
        SELECT m2.node_id FROM memory_evidence m2
        JOIN memory_nodes e2 ON e2.id=m2.node_id
        JOIN memory_chunk_sources s2 ON s2.source_id=m2.source_id
        JOIN memory_chunks c2 ON c2.memory_chunk_id=s2.episode_id AND c2.current_revision=s2.revision
        WHERE m2.episode_id=q.episode_id AND e2.type!='project' AND {} AND {}
        ORDER BY CASE WHEN e2.type IN ('preference','goal','constraint','decision','memory_atom') THEN 0 ELSE 1 END,
          CASE (SELECT salience FROM memory_claims WHERE node_id=e2.id)
            WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
          s2.observed_at DESC,m2.node_id LIMIT 1
      ) node_id
      FROM bin_queue q WHERE q.bin_position<=8 ORDER BY q.bin_position,q.bin LIMIT 64
    ",
        source.sql, claim.sql, selected_claim.sql, selected_source.sql
    );
    let mut args = source.args;
    args.extend(claim.args);
    args.extend([
        Value::Integer(bins),
        Value::Real(from_ms),
        Value::Integer(bins),
        Value::Real(duration),
    ]);
    args.extend(selected_claim.args);
    args.extend(selected_source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}
