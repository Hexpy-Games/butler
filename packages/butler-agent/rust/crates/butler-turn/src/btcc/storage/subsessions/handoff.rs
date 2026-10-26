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
    pub(crate) async fn parent_work(
        &self,
        session: String,
        work: String,
    ) -> StorageResult<Option<WorkView>> {
        self.storage.read(move |db| {
            let owned: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations d INDEXED BY idx_btcc_graph_work JOIN btcc_session_relations r USING(relation_id) WHERE json_extract(d.packet_json,'$.parent_work_ref.work_id')=?1 AND r.parent_session_id=?2 AND json_extract(d.packet_json,'$.child_role')='steward')", params![work,session], |row| row.get(0)).map_err(StorageError::sqlite)?;
            if !owned { return Ok(None) }
            super::super::work::hydrate_work_view(db, &work).map(Some)
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
