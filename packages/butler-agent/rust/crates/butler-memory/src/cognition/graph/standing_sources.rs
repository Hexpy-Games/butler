//! Global user claims for the standing-fact sheet.
use rusqlite::params;

use super::{GraphRepository, db_error};
use crate::cognition::CognitionResult;

const SOURCES: &str = "FROM memory_claims c
JOIN memory_nodes n ON n.id = c.node_id
JOIN memory_evidence e ON e.node_id = c.node_id
JOIN memory_chunks k ON k.memory_chunk_id = e.episode_id AND k.current_revision = e.revision
WHERE c.basis = 'user_statement' AND k.status = 'active' AND k.project_id IS NULL";

impl GraphRepository {
    pub(in crate::cognition) fn standing_sources(
        &self,
        through_at: &str,
        through_id: &str,
    ) -> CognitionResult<u64> {
        self.connection()?.query_row(
            &format!("SELECT COUNT(DISTINCT c.node_id) {SOURCES} AND (n.created_at, n.id) <= (?1, ?2)"),
            params![through_at, through_id],
            |row| row.get(0),
        ).map_err(db_error)
    }

    pub(in crate::cognition) fn standing_rows(
        &self,
        through_at: &str,
        through_id: &str,
        limit: usize,
    ) -> CognitionResult<Vec<(String, String, String, String)>> {
        self.connection()?.prepare(&format!(
            "SELECT n.created_at, n.id, substr(MIN(COALESCE(k.conversation_start, k.created_at)),1,10), c.statement {SOURCES} AND (n.created_at, n.id) > (?1, ?2) GROUP BY c.node_id ORDER BY n.created_at, n.id LIMIT ?3"
        )).map_err(db_error)?.query_map(params![through_at, through_id, limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        }).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }
}
