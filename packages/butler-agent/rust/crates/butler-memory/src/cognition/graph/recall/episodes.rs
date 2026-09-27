//! Source-aggregated episode rows; source and claim sets aggregate before join.

use std::collections::HashSet;

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{CognitionResult, recall::RecallRequest};

use super::{db_error, scope};

#[derive(Clone, Debug)]
pub(in crate::cognition) struct RecallEpisodeRow {
    pub episode_id: String,
    pub revision: String,
    pub has_claims: bool,
    pub conversation_at: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub event_at: Option<String>,
    pub salience: String,
    pub explicit_priority: bool,
    pub half_life_days: f64,
    pub support_count: f64,
}

pub(super) fn load(
    db: &Connection,
    input: &RecallRequest,
    episode_ids: &[String],
    raw_episodes: &HashSet<String>,
) -> CognitionResult<Vec<RecallEpisodeRow>> {
    if episode_ids.is_empty() {
        return Ok(Vec::new());
    }
    let source = scope::source(input, "s", "c");
    let claim = scope::claim(input, "claim", "node_id");
    let raw_ids = raw_episodes.iter().cloned().collect::<Vec<_>>();
    let raw_placeholders = if raw_ids.is_empty() {
        "NULL".to_owned()
    } else {
        scope::placeholders(raw_ids.len())
    };
    let sql = format!(
        r"
      WITH eligible_sources AS (
        SELECT s.* FROM memory_chunk_sources s
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE c.memory_chunk_id IN ({}) AND {}
      ), all_claims AS (
        SELECT m.episode_id,e.id node_id,e.type,m.source_id
        FROM memory_evidence m JOIN eligible_sources source ON source.source_id=m.source_id
        JOIN memory_nodes e ON e.id=m.node_id
        WHERE e.type IN ('preference','goal','constraint','decision','memory_atom')
      ), eligible_claims AS (
        SELECT claim.* FROM all_claims claim WHERE {}
      ), source_summary AS (
        SELECT episode_id,MAX(julianday(observed_at)) observed_at
        FROM eligible_sources GROUP BY episode_id
      ), claim_counts AS (
        SELECT episode_id,COUNT(DISTINCT node_id) total
        FROM all_claims GROUP BY episode_id
      ), claim_summary AS (
        SELECT eligible_claims.episode_id,COUNT(DISTINCT eligible_claims.node_id) total,
          MAX(properties.valid_from) event_at,
          MAX(CASE properties.salience WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END) salience,
          MAX(CASE WHEN eligible_claims.type='goal' THEN 1 ELSE 0 END) has_goal
        FROM eligible_claims
        LEFT JOIN memory_claims properties ON properties.node_id=eligible_claims.node_id
        GROUP BY eligible_claims.episode_id
      )
      SELECT c.memory_chunk_id,c.current_revision,
        CASE WHEN claim_counts.total>0 THEN 1 ELSE 0 END,
        strftime('%Y-%m-%dT%H:%M:%fZ',source.observed_at),
        c.conversation_session_id,c.conversation_turn_id,
        claim_summary.event_at,
        CASE claim_summary.salience WHEN 2 THEN 'high' WHEN 1 THEN 'normal' ELSE 'unspecified' END,
        0,
        CASE WHEN claim_summary.has_goal=1 THEN 7 ELSE 30 END,
        0
      FROM memory_chunks c JOIN source_summary source ON source.episode_id=c.memory_chunk_id
      LEFT JOIN claim_counts ON claim_counts.episode_id=c.memory_chunk_id
      LEFT JOIN claim_summary ON claim_summary.episode_id=c.memory_chunk_id
      WHERE COALESCE(claim_counts.total,0)=0 OR claim_summary.total>0 OR c.memory_chunk_id IN ({raw_placeholders})
      ORDER BY c.memory_chunk_id
    ",
        scope::placeholders(episode_ids.len()),
        source.sql,
        claim.sql
    );
    let mut args = episode_ids
        .iter()
        .cloned()
        .map(Value::Text)
        .collect::<Vec<_>>();
    args.extend(source.args);
    args.extend(claim.args);
    args.extend(raw_ids.into_iter().map(Value::Text));
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| {
            Ok(RecallEpisodeRow {
                episode_id: row.get(0)?,
                revision: row.get(1)?,
                has_claims: row.get::<_, i64>(2)? != 0,
                conversation_at: row.get(3)?,
                session_id: row.get(4)?,
                turn_id: row.get(5)?,
                event_at: row.get(6)?,
                salience: row.get(7)?,
                explicit_priority: row.get::<_, i64>(8)? != 0,
                half_life_days: row.get::<_, i64>(9)? as f64,
                support_count: row.get::<_, i64>(10)? as f64,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}
