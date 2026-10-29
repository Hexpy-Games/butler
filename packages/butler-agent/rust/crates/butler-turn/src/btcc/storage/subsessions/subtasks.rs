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
                let ids = db
                    .prepare_cached(OPEN_SUBTASKS_SQL)
                    .map_err(StorageError::sqlite)?
                    .query_map([parents], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, bool>(2)?,
                        ))
                    })
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)?;
                let mut rows = Vec::with_capacity(ids.len());
                for (parent, id, awaiting_decision) in ids {
                    match super::decode::read(db, "r.relation_id=?1", &id) {
                        Ok(Some(relation)) => rows.push(OpenSubtaskRow {
                            parent,
                            relation,
                            awaiting_decision,
                        }),
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
