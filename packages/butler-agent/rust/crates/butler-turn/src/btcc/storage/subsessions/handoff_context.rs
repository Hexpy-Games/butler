//! Indexed handoff context and durable replacement metadata.
use super::*;

impl SqliteSubsessionRepository {
    pub(crate) async fn user_request(
        &self,
        session: String,
        turn: String,
        message: String,
    ) -> Result<Option<String>, StorageError> {
        self.storage.read(move |db| {
            db.query_row(
                "SELECT content FROM btcc_messages WHERE message_id=?1 AND session_id=?2 AND turn_id=?3 AND role='user'",
                params![message, session, turn], |row| row.get(0),
            ).optional().map_err(StorageError::sqlite)
        }).await
    }

    /// The parent relation index bounds this lookup to one session's Work.
    pub(crate) async fn workers_for_work(
        &self,
        session: String,
        work: String,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage.read(move |db| {
            let rows = list(db, "WHERE r.parent_session_id=?1 AND r.activity_role='worker' ORDER BY r.ordinal DESC", [&session])?;
            Ok(rows.into_iter().filter(|row| row.packet.parent_work_ref.as_ref()
                .is_some_and(|parent| parent.work_id == work)).collect())
        }).await
    }

    pub(crate) async fn relation_for_result(
        &self,
        result: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage.read(move |db| {
            read(db, "r.relation_id=(SELECT relation_id FROM btcc_steward_results WHERE result_id=?1)", &result)
        }).await
    }

    pub(crate) async fn replacement_waiting(&self, relation: String) -> Result<bool, StorageError> {
        self.storage.read(move |db| {
            db.query_row("SELECT EXISTS (SELECT 1 FROM btcc_session_relations n JOIN btcc_subsession_delegations nd ON nd.relation_id=n.relation_id JOIN btcc_session_relations r ON r.parent_session_id=n.parent_session_id JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id WHERE n.relation_id=?1 AND json_extract(d.packet_json,'$.superseded_by') IS NOT NULL AND json_extract(d.packet_json,'$.parent_work_ref.work_id')=json_extract(nd.packet_json,'$.parent_work_ref.work_id') AND json_extract(d.packet_json,'$.plan_action.action_key')=json_extract(nd.packet_json,'$.plan_action.action_key') AND (NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id) OR EXISTS (SELECT 1 FROM btcc_turns t WHERE t.session_id=r.child_session_id AND NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id AND x.child_turn_id=t.turn_id))))", [relation], |r| r.get(0)).map_err(StorageError::sqlite)
        }).await
    }

    pub(crate) async fn superseded_workers(
        &self,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .read(|db| {
                list(
                    db,
                    "WHERE r.activity_role='worker'
                     AND json_extract(d.packet_json,'$.superseded_by') IS NOT NULL
                     AND (NOT EXISTS (
                         SELECT 1 FROM btcc_steward_results x
                         WHERE x.relation_id=d.relation_id
                     ) OR EXISTS (
                         SELECT 1 FROM btcc_turns t
                         WHERE t.session_id=r.child_session_id AND NOT EXISTS (
                             SELECT 1 FROM btcc_steward_results x
                             WHERE x.relation_id=d.relation_id AND x.child_turn_id=t.turn_id
                         )
                     ))",
                    [],
                )
            })
            .await
    }

    pub(crate) async fn supersede_worker(
        &self,
        old: String,
        new: String,
    ) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            db.execute("UPDATE btcc_subsession_delegations SET packet_json=json_set(packet_json,'$.superseded_by',?2) WHERE relation_id=?1", params![old, new])
                .map_err(StorageError::sqlite)?;
            Ok(())
        }).await
    }
}
