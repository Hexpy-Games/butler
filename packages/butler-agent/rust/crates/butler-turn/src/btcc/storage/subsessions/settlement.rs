//! A terminal Work's delivered result cannot be replaced by an unbound late turn.
use super::*;

pub(super) fn settled_result_id(
    db: &rusqlite::Connection,
    relation: &str,
) -> Result<Option<String>, StorageError> {
    let origin: Option<(String, String)> = db
        .query_row(
            "SELECT r.child_session_id,p.origin_turn_id FROM btcc_subsession_delegations d \
         JOIN btcc_session_relations r USING(relation_id) \
         JOIN btcc_guided_works w ON w.work_id=d.root_work_id AND w.status='completed' \
         JOIN btcc_guided_work_disposition_revisions p ON p.work_id=w.work_id \
         WHERE d.relation_id=?1 ORDER BY p.revision DESC LIMIT 1",
            [relation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((session, turn)) = origin else {
        return Ok(None);
    };
    let id = completion::turn_result_id(&session, &turn);
    db.query_row(
        "SELECT result_id FROM btcc_steward_results r WHERE result_id=?1 \
         AND NOT EXISTS(SELECT 1 FROM btcc_subsession_directions d WHERE d.relation_id=r.relation_id \
         AND d.created_at>r.created_at)",
        [id], |row| row.get(0),
    ).optional().map_err(StorageError::sqlite)
}

/// All lifecycle consumers use the same settled identity, including direction admission.
pub(super) fn settled_turn(
    db: &rusqlite::Connection,
    session: &str,
) -> Result<Option<(String, String)>, StorageError> {
    let relation: Option<String> = db
        .query_row(
            "SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1",
            [session],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some(relation) = relation else {
        return Ok(None);
    };
    let Some(id) = settled_result_id(db, &relation)? else {
        return Ok(None);
    };
    read_result_turn(db, id)
}

pub(super) fn read_result_turn(
    db: &rusqlite::Connection,
    id: String,
) -> Result<Option<(String, String)>, StorageError> {
    db.query_row(
        "SELECT child_turn_id,CASE status WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'delivered' END \
         FROM btcc_steward_results WHERE result_id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(StorageError::sqlite)
}

/// Pending directions stay active; obsolete late turns cannot reopen settled Work.
pub(super) fn has_active_child(
    db: &rusqlite::Connection,
    parent: &str,
) -> Result<bool, StorageError> {
    let mut statement = db.prepare_cached(
        "SELECT r.relation_id,EXISTS (SELECT 1 FROM btcc_subsession_directions i
                         WHERE i.relation_id=r.relation_id AND i.status='pending')
                         FROM btcc_session_relations r
                         JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id
                         WHERE r.parent_session_id=?1 AND (
                           EXISTS (SELECT 1 FROM btcc_subsession_directions i
                             WHERE i.relation_id=r.relation_id AND i.status='pending')
                           OR NOT EXISTS (SELECT 1 FROM btcc_steward_results x
                             WHERE x.relation_id=r.relation_id AND x.child_turn_id=COALESCE(
                               (SELECT t.turn_id FROM btcc_turns t
                                WHERE t.session_id=r.child_session_id ORDER BY t.rowid DESC LIMIT 1),
                               d.child_turn_id)))",
    ).map_err(StorageError::sqlite)?;
    let candidates = statement
        .query_map([parent], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })
        .map_err(StorageError::sqlite)?;
    for candidate in candidates {
        let (relation, pending) = candidate.map_err(StorageError::sqlite)?;
        if pending || settled_result_id(db, &relation)?.is_none() {
            return Ok(true);
        }
    }
    Ok(false)
}
