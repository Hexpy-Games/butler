//! One obsolete alias index per background write lease. SQLite's schema is
//! the durable work queue: an interrupted DROP rolls back and is retried.
use rusqlite::OptionalExtension;
use tokio_util::sync::CancellationToken;

use super::{GraphRepository, db_error};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};

impl GraphRepository {
    pub(in crate::cognition) fn obsolete_alias_index(&self) -> CognitionResult<Option<String>> {
        self.connection()?
            .query_row(
                "SELECT name FROM sqlite_schema WHERE type='index' AND name IN
             ('idx_alias_postings_entity','idx_alias_postings_scope_gram_node')
             ORDER BY name LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    }

    pub(in crate::cognition) fn drop_obsolete_alias_index(
        &self,
        stop: &CancellationToken,
    ) -> CognitionResult<bool> {
        if stop.is_cancelled() {
            return Err(aborted());
        }
        let Some(index) = self.obsolete_alias_index()? else {
            return Ok(false);
        };
        let db = self.connection()?;
        // Bound contention too: interrupt() alone cannot end SQLite's busy wait.
        db.busy_timeout(std::time::Duration::from_millis(50))
            .map_err(db_error)?;
        let watcher = super::cache_work::interrupt_on_stop(db.get_interrupt_handle(), stop);
        let cancellation = stop.clone();
        db.progress_handler(1, Some(move || cancellation.is_cancelled()));
        // index comes exclusively from the two fixed names in sqlite_schema.
        let result = db
            .execute_batch(&format!("DROP INDEX IF EXISTS {index}"))
            .map_err(db_error);
        if let Some(watcher) = watcher {
            watcher.abort();
        }
        db.progress_handler(0, None::<fn() -> bool>);
        if stop.is_cancelled() {
            return Err(aborted());
        }
        result.map(|()| true)
    }
}

fn aborted() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryOperationAborted,
        "memory_operation_aborted",
    )
}

#[cfg(test)]
pub(super) fn assert_interrupted_retirement() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE memory_alias_postings(node_id,gram,source_id,surface_original,identity_scope,project_id);
        WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<10000)
        INSERT INTO memory_alias_postings SELECT n,'abc','s','surface','user',NULL FROM ids;
        CREATE INDEX idx_alias_postings_entity ON memory_alias_postings(node_id,gram,source_id,surface_original);
        CREATE INDEX idx_alias_postings_scope_gram_node ON memory_alias_postings(identity_scope,project_id,gram,node_id);").unwrap();
    let graph = GraphRepository {
        connection: Some(db),
    };
    let stop = CancellationToken::new();
    let cancelled = stop.clone();
    let db = graph.connection().unwrap();
    db.authorizer(Some(move |context: AuthContext<'_>| {
        if matches!(context.action, AuthAction::DropIndex { .. }) {
            cancelled.cancel();
        }
        Authorization::Allow
    }));
    assert!(graph.drop_obsolete_alias_index(&stop).is_err());
    db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    assert_eq!(
        graph.obsolete_alias_index().unwrap().as_deref(),
        Some("idx_alias_postings_entity")
    );
    let stop = CancellationToken::new();
    assert!(graph.drop_obsolete_alias_index(&stop).unwrap());
    assert_eq!(
        graph.obsolete_alias_index().unwrap().as_deref(),
        Some("idx_alias_postings_scope_gram_node")
    );
    assert!(graph.drop_obsolete_alias_index(&stop).unwrap());
    assert!(!graph.drop_obsolete_alias_index(&stop).unwrap());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM memory_alias_postings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        10000
    );
}
