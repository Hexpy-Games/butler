//! Indexed parent links for usage lineage; no delegation packet decoding.
use super::{SqliteSubsessionRepository, StorageError};
use rusqlite::params_from_iter;

#[cfg(test)]
pub(super) mod tests;

/// A child's parent and optional policy role from the relation index.
type ParentLink = (String, String, Option<String>);

impl SqliteSubsessionRepository {
    /// Indexed append watermark, cheap with retained history.
    pub async fn relation_watermark(&self) -> Result<i64, StorageError> {
        self.storage
            .read(|db| {
                db.query_row(
                    "SELECT COALESCE(MAX(rowid),0) FROM btcc_session_relations",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }

    /// Only relations appended since the last successfully resolved watermark.
    pub async fn parent_links_since(
        &self,
        previous: i64,
        watermark: i64,
    ) -> Result<Vec<ParentLink>, StorageError> {
        self.storage
            .read(move |db| {
                let mut statement = db
                    .prepare(
                        "SELECT child_session_id,parent_session_id,activity_role \
                 FROM btcc_session_relations WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid",
                    )
                    .map_err(StorageError::sqlite)?;
                statement
                    .query_map([previous, watermark], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)
            })
            .await
    }

    /// Resolve children in bounded indexed batches, including legacy relations.
    pub async fn parent_links(
        &self,
        children: Vec<String>,
    ) -> Result<Vec<ParentLink>, StorageError> {
        self.storage
            .read(move |db| {
                let mut links = Vec::new();
                for chunk in children.chunks(500) {
                    let placeholders = std::iter::repeat_n("?", chunk.len())
                        .collect::<Vec<_>>()
                        .join(",");
                    let sql = format!(
                        "SELECT child_session_id,parent_session_id,activity_role \
                         FROM btcc_session_relations WHERE child_session_id IN ({placeholders})"
                    );
                    let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
                    let rows = statement
                        .query_map(params_from_iter(chunk), |row| {
                            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                        })
                        .map_err(StorageError::sqlite)?;
                    for row in rows {
                        links.push(row.map_err(StorageError::sqlite)?);
                    }
                }
                Ok(links)
            })
            .await
    }
}

/// Queue admission reads only legacy execution state. An approval-held child is
/// idle; a pending result still owns its place until admission to the parent.
const QUEUE_WAITS_FOR_CHILD: &str = "SELECT EXISTS(
    SELECT 1 FROM btcc_session_relations r
    JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id
    WHERE r.parent_session_id=?1 AND (
        (r.activity_terminal=0 AND (
            EXISTS(SELECT 1 FROM btcc_turns t WHERE t.turn_id=(
                SELECT latest.turn_id FROM btcc_turns latest
                WHERE latest.session_id=r.child_session_id ORDER BY latest.rowid DESC LIMIT 1)
                AND ((t.semantic_state IN ('admitted','delivery_committed')
                      AND t.suspension_reason IS NULL)
                     OR t.suspension_reason='waiting_for_worker'))
            OR (d.dispatch_state IN ('pending','enqueued') AND d.dispatch_intent_json IS NOT NULL
                AND NOT EXISTS(SELECT 1 FROM btcc_turns t WHERE t.session_id=r.child_session_id))))
        OR EXISTS(SELECT 1 FROM btcc_steward_results x
            JOIN btcc_subsession_outbox o ON o.result_id=x.result_id
            WHERE x.relation_id=r.relation_id AND o.status='pending')))
";

impl SqliteSubsessionRepository {
    /// A pure read through the read pool, independent of the BTCC writer lane.
    pub async fn queue_waits_for_child(&self, parent: String) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(QUEUE_WAITS_FOR_CHILD, [parent], |row| row.get(0))
                    .map_err(StorageError::sqlite)
            })
            .await
    }
}
