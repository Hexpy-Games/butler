//! Deferred, interruptible cache-job index and read-only work detection.
use super::{GraphRepository, db_error};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use rusqlite::OptionalExtension;
use tokio_util::sync::CancellationToken;

pub(super) const INDEX_SQL: &str = "CREATE INDEX IF NOT EXISTS idx_jobs_hot_cache ON memory_projection_jobs(json_extract(hot_cache_state,'$.state'),last_served_at IS NOT NULL,last_served_at,created_at,job_id) WHERE json_valid(hot_cache_state)";
pub(super) const CLAIM_SQL: &str = r"SELECT j.job_id,j.episode_id,j.revision,j.generation,c.summary,c.summary_status,c.project_id,
                    c.conversation_session_id,COALESCE(c.conversation_start,c.created_at),c.source_key,c.source_hash,
                    j.extraction_version,COALESCE((SELECT s.source_kind FROM memory_chunk_sources s WHERE s.episode_id=j.episode_id AND s.revision=j.revision ORDER BY s.source_id LIMIT 1),''),j.hot_cache_attempt_count,(c.current_revision=j.revision AND c.status='active')
             FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id 
             WHERE json_valid(j.hot_cache_state) AND json_extract(j.hot_cache_state,'$.state')='pending' AND (c.current_revision!=j.revision OR c.status!='active' OR c.summary_status='complete'
                    OR json_extract(j.semantic_graph_state,'$.state') IN ('complete','failed')
                    OR (json_extract(j.semantic_graph_state,'$.state')='partial' AND COALESCE(json_extract(j.semantic_graph_state,'$.pending_units'),0)=0))
                    AND (j.hot_cache_next_attempt_at IS NULL OR j.hot_cache_next_attempt_at<=?1)
             ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id LIMIT 1";
const RECOVERY_SQL: &str = "SELECT 1 FROM memory_projection_jobs WHERE json_valid(hot_cache_state) AND json_extract(hot_cache_state,'$.state')='running' UNION ALL SELECT 1 FROM memory_episode_fts_pending UNION ALL SELECT 1 FROM memory_state WHERE key='episode_fts_script_cursor' LIMIT 1";

impl GraphRepository {
    pub(in crate::cognition) fn cache_index_ready(&self) -> CognitionResult<bool> {
        self.connection()?
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE name='idx_jobs_hot_cache' AND EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_seeded') AND EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_trigger_version' AND value='2')",
                [],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(db_error)
    }

    /// Called only by the background cache stage under the consolidation lease.
    pub(in crate::cognition) fn ensure_cache_index(
        &self,
        stop: &CancellationToken,
    ) -> CognitionResult<()> {
        if stop.is_cancelled() {
            return Err(CognitionError::new(
                CognitionCode::MemoryOperationAborted,
                "memory_operation_aborted",
            ));
        }
        if self.cache_index_ready()? {
            return Ok(());
        }
        let db = self.connection()?;
        let watcher = interrupt_on_stop(db.get_interrupt_handle(), stop);
        let cancellation = stop.clone();
        db.progress_handler(1000, Some(move || cancellation.is_cancelled()));
        let result = (|| {
            let tx = db.unchecked_transaction().map_err(db_error)?;
            tx.execute_batch(INDEX_SQL).map_err(db_error)?;
            super::episode_fts::install(&tx)?;
            tx.commit().map_err(db_error)
        })();
        if let Some(watcher) = watcher {
            watcher.abort();
        }
        db.progress_handler(0, None::<fn() -> bool>);
        if stop.is_cancelled() {
            return Err(CognitionError::new(
                CognitionCode::MemoryOperationAborted,
                "memory_operation_aborted",
            ));
        }
        result
    }

    /// Missing index requests one background build, never an unindexed poll.
    pub(in crate::cognition) fn has_cache_work(&self, now: &str) -> CognitionResult<bool> {
        if !self.cache_index_ready()? {
            return Ok(true);
        }
        let db = self.connection()?;
        if db
            .query_row(RECOVERY_SQL, [], |_| Ok(()))
            .optional()
            .map_err(db_error)?
            .is_some()
        {
            return Ok(true);
        }
        db.query_row(CLAIM_SQL, [now], |_| Ok(()))
            .optional()
            .map(|value| value.is_some())
            .map_err(db_error)
    }
}

/// Interrupt also reaches SQLite sorting work between VM progress callbacks.
/// This observer owns no writer or file work, and is aborted when creation ends.
pub(super) fn interrupt_on_stop(
    handle: rusqlite::InterruptHandle,
    stop: &CancellationToken,
) -> Option<tokio::task::JoinHandle<()>> {
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let stop = stop.clone();
    Some(runtime.spawn(async move {
        stop.cancelled().await;
        handle.interrupt();
    }))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(in crate::cognition::graph) fn assert_query_plan() {
        let mut db = butler_platform::sqlite::Connection::open_in_memory().unwrap();
        super::super::schema::ensure(&mut db, "2026-10-02T00:00:00Z").unwrap();
        let mut graph = GraphRepository {
            _reader_pin: None,
            connection: Some(db),
        };
        assert!(!graph.cache_index_ready().unwrap());
        assert!(graph.has_cache_work("2026-10-02T00:00:00Z").unwrap());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(graph.ensure_cache_index(&cancelled).is_err());
        assert!(!graph.cache_index_ready().unwrap());
        assert_interrupted_build(&graph);
        graph.ensure_cache_index(&CancellationToken::new()).unwrap();
        let revision = |graph: &GraphRepository| {
            graph
                .connection()
                .unwrap()
                .query_row(
                    "SELECT CAST(value AS INTEGER) FROM memory_state WHERE key='graph_revision'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
        };
        let before = revision(&graph);
        // Completing an empty migration changes coverage and invalidates selections.
        assert!(
            graph
                .advance_episode_fts(&CancellationToken::new())
                .unwrap()
        );
        assert_eq!(revision(&graph), before + 1);
        assert!(
            !graph
                .advance_episode_fts(&CancellationToken::new())
                .unwrap()
        );
        assert_eq!(revision(&graph), before + 1);
        let db = graph.connection().unwrap();
        super::super::episode_fts::reindex::assert_resumable(db);
        for sql in [CLAIM_SQL, RECOVERY_SQL] {
            let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let arguments = if sql == CLAIM_SQL {
                vec!["2026-10-02T00:00:00Z"]
            } else {
                vec![]
            };
            let plan = statement
                .query_map(rusqlite::params_from_iter(arguments), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                plan.iter().any(|line| line.contains("idx_jobs_hot_cache")),
                "{plan:?}"
            );
            assert!(
                !plan.iter().any(|line| line.starts_with("SCAN j")
                    || line.contains("SCAN memory_projection_jobs")),
                "{plan:?}"
            );
        }
        assert!(!graph.has_cache_work("2026-10-02T00:00:00Z").unwrap());
    }
    fn assert_interrupted_build(graph: &GraphRepository) {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        let db = graph.connection().unwrap();
        db.execute_batch(r#"WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<2000)
            INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
            SELECT CAST(n AS TEXT),CAST(n AS TEXT),'1','v3','g','stub','low','[]','{}','{}','{}','{}','{"state":"complete"}','now' FROM ids;"#).unwrap();
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        // Cancel after SQLite starts preparing CREATE INDEX, beyond the
        // stage's preflight check, so its installed progress hook aborts it.
        db.authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(context.action, AuthAction::CreateIndex { .. }) {
                cancelled.cancel();
            }
            Authorization::Allow
        }));
        assert!(graph.ensure_cache_index(&stop).is_err());
        db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        assert!(!graph.cache_index_ready().unwrap());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM memory_projection_jobs", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2000
        );
    }
}
