//! Open delegated subtasks of the requested conversations, by indexed parent lookups.
use super::{SqliteSubsessionRepository, StorageError, StoredSubsessionDelegation};

/// One unfinished steward child and whether its subtree waits on the owner.
pub(crate) struct OpenSubtaskRow {
    pub parent: String,
    pub relation: StoredSubsessionDelegation,
    pub awaiting_decision: bool,
}

/// Unfinished direct steward children of the given owners (`?1`, a JSON
/// array). A child waits on the owner while any open relation below it holds
/// a pending decision; the owner's pending requests are read through the
/// owner index, so neither the relation nor the authority history is scanned.
pub const OPEN_SUBTASKS_SQL: &str = r"WITH RECURSIVE
    tops(parent,relation,session,created) AS (
        SELECT p.value,r.relation_id,r.child_session_id,r.created_at FROM json_each(?1) p
        JOIN btcc_session_relations r INDEXED BY idx_btcc_activity_parent_open_page
            ON r.parent_session_id=p.value
        WHERE r.activity_terminal=0 AND r.activity_role='steward'),
    subtree(relation,session) AS (
        SELECT relation,session FROM tops
        UNION SELECT s.relation,r.child_session_id FROM subtree s
        JOIN btcc_session_relations r INDEXED BY idx_btcc_activity_parent_open_page
            ON r.parent_session_id=s.session
        WHERE r.activity_terminal=0)
    SELECT t.parent,t.relation,EXISTS(SELECT 1 FROM btcc_authority_requests a
        JOIN btcc_turns u ON u.turn_id=a.source_turn_id
        WHERE a.owner_session_id=t.parent AND a.decision='pending' AND a.close_reason IS NULL
        AND u.semantic_state='admitted' AND u.suspension_reason='authority_pending'
        AND a.source_session_id IN (SELECT s.session FROM subtree s WHERE s.relation=t.relation))
    FROM tops t ORDER BY t.parent,t.created,t.relation";

impl SqliteSubsessionRepository {
    /// Bounded by the requested owners' open children; undecodable rows are skipped.
    pub(crate) async fn open_subtasks(
        &self,
        parents: Vec<String>,
    ) -> Result<Vec<OpenSubtaskRow>, StorageError> {
        self.owner_relations(
            OPEN_SUBTASKS_SQL,
            parents,
            |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    (row.get::<_, String>(0)?, row.get::<_, bool>(2)?),
                ))
            },
            |_, relation, (parent, awaiting_decision): (String, bool)| {
                Ok(OpenSubtaskRow {
                    parent,
                    relation,
                    awaiting_decision,
                })
            },
        )
        .await
    }
}

/// Direct Workers, including finished ones, in delegation order for each subtask.
pub const SUBTASK_WORKERS_SQL: &str = r"SELECT r.relation_id
    FROM json_each(?1) p
    JOIN btcc_session_relations r INDEXED BY idx_btcc_activity_parent_page
        ON r.parent_session_id=p.value
    WHERE r.activity_role='worker'
    ORDER BY r.parent_session_id,r.ordinal";

impl SqliteSubsessionRepository {
    /// One snapshot for all requested subtasks and their indexed child status reads.
    pub(crate) async fn subtask_workers(
        &self,
        parents: Vec<String>,
    ) -> Result<Vec<(StoredSubsessionDelegation, &'static str)>, StorageError> {
        self.owner_relations(
            SUBTASK_WORKERS_SQL,
            parents,
            |row| Ok((row.get::<_, String>(0)?, ())),
            |db, relation, ()| {
                let (_, status) = super::activity::child_activity(db, &relation)?;
                Ok((relation, status))
            },
        )
        .await
    }

    /// Runs `sql` with the owners as one JSON array (`?1`) in a single read
    /// snapshot. `key` returns each row's relation id plus the columns `build`
    /// needs; relations that are gone or undecodable are skipped.
    async fn owner_relations<K, T, F, B>(
        &self,
        sql: &'static str,
        parents: Vec<String>,
        key: F,
        build: B,
    ) -> Result<Vec<T>, StorageError>
    where
        K: Send + 'static,
        T: Send + 'static,
        F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<(String, K)> + Send + 'static,
        B: Fn(&rusqlite::Connection, StoredSubsessionDelegation, K) -> Result<T, StorageError>
            + Send
            + 'static,
    {
        if parents.is_empty() {
            return Ok(Vec::new());
        }
        let parents = serde_json::to_string(&parents).map_err(|error| {
            StorageError::new(
                crate::btcc::StorageCode::SubsessionPacketInvalid,
                error.to_string(),
            )
        })?;
        self.storage
            .read(move |db| {
                let keys = db
                    .prepare_cached(sql)
                    .map_err(StorageError::sqlite)?
                    .query_map([parents], key)
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)?;
                let mut rows = Vec::with_capacity(keys.len());
                for (id, columns) in keys {
                    match super::decode::read(db, "r.relation_id=?1", &id) {
                        Ok(Some(relation)) => rows.push(build(db, relation, columns)?),
                        Ok(None) => {}
                        Err(error)
                            if error.code()
                                == crate::btcc::StorageCode::SubsessionPacketInvalid.as_str() => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(rows)
            })
            .await
    }
}
