//! Parent Work, Plan and pending child intent share the BTCC writer commit.
use super::super::StorageResult;
use super::*;
use crate::btcc::{WorkTurnScope, WorkView};
use rusqlite::Connection;

pub(super) fn insert(db: &Connection, input: &SubsessionCreate) -> StorageResult<bool> {
    let encode = |error: serde_json::Error| {
        StorageError::new(StorageCode::SubsessionPacketInvalid, error.to_string())
            .with_source(error)
    };
    let packet_json = serde_json::to_string(&input.packet).map_err(encode)?;
    let intent_json = serde_json::to_string(&input.dispatch_intent).map_err(encode)?;
    let ordinal: i64 = db.query_row(
        "SELECT COALESCE(MAX(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?1",
        [&input.parent_session_id], |row| row.get(0),
    ).map_err(StorageError::sqlite)?;
    let inserted = db.execute(
        "INSERT OR IGNORE INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![input.relation_id,input.parent_session_id,input.parent_turn_id,input.child_session_id,input.anchor_message_id,ordinal,input.safe_title,input.created_at],
    ).map_err(StorageError::sqlite)? == 1;
    if inserted {
        db.execute(
            "INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)",
            params![input.delegation_id,input.relation_id,input.task_id,input.child_turn_id,input.root_work_id,packet_json,intent_json,input.created_at],
        ).map_err(StorageError::sqlite)?;
    }
    Ok(inserted)
}

impl SqliteSubsessionRepository {
    pub(crate) async fn settled_parent_source(
        &self,
        session: String,
        work: String,
    ) -> StorageResult<Option<(String, String, String)>> {
        self.storage.read(move |db| {
            db.query_row("SELECT r.parent_turn_id,x.result_id,x.status FROM btcc_subsession_delegations d INDEXED BY idx_btcc_graph_work JOIN btcc_session_relations r USING(relation_id) JOIN btcc_steward_results x USING(relation_id) WHERE json_extract(d.packet_json,'$.parent_work_ref.work_id')=?1 AND r.parent_session_id=?2 AND json_extract(d.packet_json,'$.child_role')='steward' ORDER BY x.created_at DESC,r.ordinal DESC LIMIT 1", params![work,session], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(StorageError::sqlite)
        }).await
    }

    pub(crate) async fn create_handoff<F>(
        &self,
        scope: WorkTurnScope,
        call_id: String,
        objective: String,
        plan: (Vec<String>, Vec<String>, bool),
        now: String,
        build: F,
    ) -> StorageResult<StoredSubsessionDelegation>
    where
        F: Fn(WorkView) -> StorageResult<SubsessionCreate> + Send + 'static,
    {
        self.storage.execute(move |db| {
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(StorageError::sqlite)?;
            let tx = butler_canon::store::Transaction::new(tx).map_err(super::super::canon::work_error)?;
            // The journal mutation identity survives a crash after this commit.
            let replay: Option<String> = tx.query_row(
                "SELECT d.delegation_id FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.parent_session_id=?3 AND r.parent_turn_id=?1 AND json_extract(d.packet_json,'$.source_tool_call_id')=?2",
                params![scope.turn_id,call_id,scope.session_id], |row| row.get(0),
            ).optional().map_err(StorageError::sqlite)?;
            if let Some(id) = replay {
                return read(&tx, "d.delegation_id=?1", &id)?.ok_or_else(|| StorageError::new(StorageCode::SubsessionRelationMissing, "Stored handoff is missing"));
            }
            let (checks, refs, reuse_reviewed) = plan;
            // Older journals predate source_tool_call_id on Steward packets.
            // Match their unchanged reviewed identity before selecting new Work.
            if reuse_reviewed
                && let Some(work) = super::super::work::legacy_steward_parent(&tx, &scope.turn_id)? {
                let candidate = build(work)?;
                if let Some(existing) = read(&tx, "d.delegation_id=?1", &candidate.delegation_id)?
                    .filter(|row| row.packet.source_tool_call_id.is_none()) {
                    return Ok(existing);
                }
            }
            let work = super::super::work::prepare_steward_work(&tx, scope, &call_id, objective, (checks, refs), reuse_reviewed, &now)?;
            link_canon(&tx, &work, &now)?;
            let input = build(work)?;
            insert(&tx, &input)?;
            let stored = read(&tx,"d.delegation_id=?1", &input.delegation_id)?.ok_or_else(|| StorageError::new(StorageCode::SubsessionRelationMissing, "Stored handoff is missing"))?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(stored)
        }).await
    }
}

fn link_canon(
    tx: &butler_canon::store::Transaction<'_>,
    work: &WorkView,
    now: &str,
) -> StorageResult<()> {
    let refs = work
        .current_plan
        .as_ref()
        .map(|plan| plan.governing_refs.as_slice())
        .unwrap_or_default();
    let rejection =
        butler_canon::store::precheck_epic_link(tx, &work.session_id, Some(&work.work_id), refs)
            .map_err(super::super::canon::work_error)?;
    if let Some(rejection) = rejection {
        let code = match rejection.get("code").and_then(Value::as_str) {
            Some("canon_epic_refs_multiple") => "canon_epic_refs_multiple",
            Some("canon_epic_link_conflict") => "canon_epic_link_conflict",
            _ => "canon_epic_not_bound",
        };
        return Err(StorageError::Port {
            code,
            message: rejection
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            source: None,
        });
    }
    butler_canon::store::link_work(
        tx,
        &butler_canon::store::runtime_context(
            chrono::DateTime::parse_from_rfc3339(now)
                .map(|time| time.timestamp_millis())
                .unwrap_or_default(),
        ),
        &work.session_id,
        &work.work_id,
        refs,
    )
    .map_err(super::super::canon::work_error)
}

impl SqliteSubsessionRepository {
    pub(crate) async fn handoff_for_call(
        &self,
        scope: WorkTurnScope,
        call: String,
    ) -> StorageResult<Option<StoredSubsessionDelegation>> {
        self.storage.read(move |db| {
            let id: Option<String> = db.query_row("SELECT d.delegation_id FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.parent_session_id=?1 AND r.parent_turn_id=?2 AND json_extract(d.packet_json,'$.source_tool_call_id')=?3", params![scope.session_id, scope.turn_id, call], |row| row.get(0)).optional().map_err(StorageError::sqlite)?;
            id.map(|id| read(db, "d.delegation_id=?1", &id)).transpose().map(Option::flatten)
        }).await
    }

    pub(crate) async fn precheck_handoff(
        &self,
        session: String,
        work: Option<String>,
        refs: Vec<String>,
    ) -> StorageResult<()> {
        self.storage
            .canon_read(move |db| {
                butler_canon::store::precheck_epic_link(db, &session, work.as_deref(), &refs)
            })
            .await
            .map_err(|error| StorageError::Port {
                code: "canon_precheck_failed",
                message: error.message(),
                source: None,
            })?
            .map_or(Ok(()), |rejection| {
                Err(StorageError::Port {
                    code: match rejection.get("code").and_then(Value::as_str) {
                        Some("canon_epic_refs_multiple") => "canon_epic_refs_multiple",
                        Some("canon_epic_link_conflict") => "canon_epic_link_conflict",
                        _ => "canon_epic_not_bound",
                    },
                    message: rejection
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    source: None,
                })
            })
    }

    pub(crate) async fn create_project_handoff(
        &self,
        input: SubsessionCreate,
        work: WorkView,
        now: String,
    ) -> StorageResult<StoredSubsessionDelegation> {
        self.storage
            .execute(move |db| {
                let tx = db
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(StorageError::sqlite)?;
                let tx = butler_canon::store::Transaction::new(tx)
                    .map_err(super::super::canon::work_error)?;
                insert(&tx, &input)?;
                link_canon(&tx, &work, &now)?;
                let stored =
                    read(&tx, "d.delegation_id=?1", &input.delegation_id)?.ok_or_else(|| {
                        StorageError::new(
                            StorageCode::SubsessionRelationMissing,
                            "Stored handoff is missing",
                        )
                    })?;
                tx.commit().map_err(StorageError::sqlite)?;
                Ok(stored)
            })
            .await
    }
}

impl SqliteSubsessionRepository {
    pub(crate) async fn settlement_result(&self, result: String) -> StorageResult<Option<Value>> {
        self.storage.read(move |db| {
            let row: Option<(String,String,String,String)> = db.query_row(
                "SELECT status,summary,acceptance_evidence_json,child_turn_id FROM btcc_steward_results WHERE result_id=?1", [result],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional().map_err(StorageError::sqlite)?;
            row.map(|(status,summary,evidence,turn)| {
                let evidence: Vec<String> = serde_json::from_str(&evidence).map_err(|error| StorageError::new(StorageCode::SubsessionResultInvalid, error.to_string()).with_source(error))?;
                Ok(serde_json::json!({"status":status,"summary":summary,"acceptance_evidence":evidence,"child_turn_id":turn}))
            }).transpose()
        }).await
    }
}
