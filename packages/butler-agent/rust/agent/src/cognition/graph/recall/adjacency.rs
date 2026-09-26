//! Source-qualified graph expansion pages inside the pinned snapshot.

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{EligibleAdjacency, RecallEdge, RecallRequest},
};

use super::{db_error, scope};

pub(super) fn load(
    db: &Connection,
    input: &RecallRequest,
    node_id: &str,
    limit: usize,
    offset: usize,
) -> CognitionResult<EligibleAdjacency> {
    let requested = limit.clamp(1, 256);
    let claim = scope::claim(input, "claim", "id");
    let source = scope::source(input, "s", "c");
    let dependency = scope::source(input, "ds", "dc");
    let sql = format!(
        r#"
      SELECT e.edge_id,e.source_node_id,e.target_node_id,e.rel_type,e.claim_node_id,
        COUNT(DISTINCT s.episode_id) support
      FROM edges e
      JOIN edge_evidence ee ON ee.edge_id=e.edge_id
      LEFT JOIN memory_nodes claim ON claim.id=e.claim_node_id
      JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE (e.source_node_id=? OR e.target_node_id=?) AND e.status='active'
        AND e.rel_type IN ('related_to','depends_on','likes','dislikes','decided','has_subject','has_object',
          'condition_member','belongs_to','co_occurred','identity_match','same_claim')
        AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
        AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))
        AND (e.claim_node_id IS NULL OR {}) AND {}
        AND NOT EXISTS (
          SELECT 1 FROM edge_evidence dependency
          LEFT JOIN memory_chunk_sources ds ON ds.source_id=dependency.chunk_source_id
          LEFT JOIN memory_chunks dc ON dc.memory_chunk_id=ds.episode_id AND dc.current_revision=ds.revision
          WHERE dependency.edge_id=e.edge_id
            AND (dc.memory_chunk_id IS NULL OR NOT ({}))
        )
      GROUP BY e.edge_id
      ORDER BY CASE WHEN e.rel_type IN ('belongs_to','co_occurred','identity_match','same_claim') THEN 1 ELSE 0 END,
        support DESC,e.rel_type,
        CASE WHEN e.source_node_id=? THEN e.target_node_id ELSE e.source_node_id END,e.edge_id
      LIMIT {} OFFSET {}
    "#,
        claim.sql,
        source.sql,
        dependency.sql,
        requested + 1,
        offset
    );
    let mut args = vec![
        Value::Text(node_id.to_owned()),
        Value::Text(node_id.to_owned()),
        Value::Text(input.as_of.clone()),
        Value::Text(input.as_of.clone()),
    ];
    args.extend(claim.args);
    args.extend(source.args);
    args.extend(dependency.args);
    args.push(Value::Text(node_id.to_owned()));
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let mut edges = statement
        .query_map(params_from_iter(args), |row| {
            Ok(RecallEdge {
                edge_id: row.get(0)?,
                source_node_id: row.get(1)?,
                target_node_id: row.get(2)?,
                relation: row.get(3)?,
                claim_node_id: row.get(4)?,
                support: row.get::<_, i64>(5)? as f64,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let truncated = edges.len() > requested;
    edges.truncate(requested);
    Ok(EligibleAdjacency { edges, truncated })
}
