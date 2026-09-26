//! Durable subsession state on the existing BTCC SQLite owner.

mod activity;

use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::{BtccStorage, StorageError};

#[derive(Clone, Debug)]
pub(crate) struct SubsessionCreate {
    pub relation_id: String,
    pub delegation_id: String,
    pub task_id: String,
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub child_session_id: String,
    pub child_turn_id: String,
    pub anchor_message_id: String,
    pub safe_title: String,
    pub root_work_id: String,
    pub packet: Value,
    pub dispatch_intent: Value,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredSubsessionDelegation {
    pub relation_id: String,
    pub delegation_id: String,
    pub task_id: String,
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub child_session_id: String,
    pub child_turn_id: String,
    pub root_work_id: String,
    pub packet: Value,
    pub dispatch_intent: Value,
    pub anchor_message_id: String,
    pub ordinal: i64,
    pub safe_title: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredSubsessionDirection {
    pub instruction_id: String,
    pub relation_id: String,
    pub revision: i64,
    pub instruction: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredSubsessionResumeTurn {
    pub turn_id: String,
    pub semantic_state: String,
    pub original_event_id: String,
    pub original_message_id: String,
    pub original_message: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingParentInput {
    pub result_id: String,
    pub parent_session_id: String,
    pub route: ParentResultRoute,
    pub input: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParentResultRoute {
    StewardQueue,
    ButlerApp,
}

#[derive(Clone)]
pub(crate) struct SqliteSubsessionRepository {
    storage: BtccStorage,
}

impl SqliteSubsessionRepository {
    pub(crate) fn new(storage: BtccStorage) -> Self {
        Self { storage }
    }

    pub(crate) async fn create(&self, input: SubsessionCreate) -> Result<bool, StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let ordinal: i64 = tx.query_row(
                "SELECT COALESCE(MAX(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?1",
                [&input.parent_session_id], |row| row.get(0),
            ).map_err(StorageError::sqlite)?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![input.relation_id,input.parent_session_id,input.parent_turn_id,input.child_session_id,input.anchor_message_id,ordinal,input.safe_title,input.created_at],
            ).map_err(StorageError::sqlite)? == 1;
            if inserted {
                tx.execute(
                    "INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)",
                    params![input.delegation_id,input.relation_id,input.task_id,input.child_turn_id,input.root_work_id,input.packet.to_string(),input.dispatch_intent.to_string(),input.created_at],
                ).map_err(StorageError::sqlite)?;
            }
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(inserted)
        }).await
    }

    pub(crate) async fn by_delegation(
        &self,
        id: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| read(db, "d.delegation_id=?1", &id))
            .await
    }

    pub(crate) async fn by_child(
        &self,
        id: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| read(db, "r.child_session_id=?1", &id))
            .await
    }

    pub(crate) async fn relation_by_id(
        &self,
        id: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| read(db, "r.relation_id=?1", &id))
            .await
    }

    pub(crate) async fn relations_for_parent(
        &self,
        parent: String,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| {
                let mut statement = db
                    .prepare(&format!(
                        "{SELECT} WHERE r.parent_session_id=?1 ORDER BY r.ordinal"
                    ))
                    .map_err(StorageError::sqlite)?;
                let rows = statement
                    .query_map([parent], row)
                    .map_err(StorageError::sqlite)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn create_direction(
        &self,
        relation: String,
        source_turn: String,
        source_message: String,
        instruction: String,
        instruction_id: String,
        now: String,
    ) -> Result<StoredSubsessionDirection, StorageError> {
        self.storage.execute(move |db| {
            let tx=db.transaction().map_err(StorageError::sqlite)?;
            let revision:i64=tx.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM btcc_subsession_directions WHERE relation_id=?1",[&relation],|r|r.get(0)).map_err(StorageError::sqlite)?;
            tx.execute("INSERT OR IGNORE INTO btcc_subsession_directions (instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)",params![instruction_id,relation,revision,source_turn,source_message,instruction,now]).map_err(StorageError::sqlite)?;
            let stored=tx.query_row("SELECT instruction_id,relation_id,revision,instruction,created_at FROM btcc_subsession_directions WHERE relation_id=?1 AND source_message_id=?2",params![relation,source_message],direction_row).map_err(StorageError::sqlite)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(stored)
        }).await
    }

    pub(crate) async fn pending_direction(
        &self,
        relation: String,
    ) -> Result<Option<StoredSubsessionDirection>, StorageError> {
        self.storage.execute(move |db| db.query_row("SELECT instruction_id,relation_id,revision,instruction,created_at FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending' ORDER BY revision LIMIT 1",[relation],direction_row).optional().map_err(StorageError::sqlite)).await
    }

    pub(crate) async fn pending_directions(
        &self,
    ) -> Result<Vec<StoredSubsessionDirection>, StorageError> {
        self.storage.execute(move |db| {
            let mut statement=db.prepare("SELECT instruction_id,relation_id,revision,instruction,created_at FROM btcc_subsession_directions WHERE status='pending' ORDER BY relation_id,revision").map_err(StorageError::sqlite)?;
            let rows=statement.query_map([],direction_row).map_err(StorageError::sqlite)?;
            rows.collect::<Result<Vec<_>,_>>().map_err(StorageError::sqlite)
        }).await
    }

    pub(crate) async fn consume_direction(
        &self,
        child: String,
        child_turn: String,
        now: String,
    ) -> Result<Option<StoredSubsessionDirection>, StorageError> {
        self.storage.execute(move |db| {
            let tx=db.transaction().map_err(StorageError::sqlite)?;
            let relation:Option<String>=tx.query_row("SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1",[child],|r|r.get(0)).optional().map_err(StorageError::sqlite)?;
            let Some(relation)=relation else { return Ok(None) };
            let direction=tx.query_row("SELECT instruction_id,relation_id,revision,instruction,created_at FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending' ORDER BY revision LIMIT 1",[&relation],direction_row).optional().map_err(StorageError::sqlite)?;
            if let Some(value)=&direction {
                tx.execute("UPDATE btcc_subsession_directions SET status='applied',applied_at=?2,applied_child_turn_id=?3 WHERE instruction_id=?1 AND status='pending'",params![value.instruction_id,now,child_turn]).map_err(StorageError::sqlite)?;
            }
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(direction)
        }).await
    }

    pub(crate) async fn latest_turn(
        &self,
        session: String,
    ) -> Result<Option<(String, String)>, StorageError> {
        self.storage.execute(move |db| db.query_row("SELECT turn_id,semantic_state FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(StorageError::sqlite)).await
    }

    pub(crate) async fn latest_resume_turn(
        &self,
        session: String,
    ) -> Result<Option<StoredSubsessionResumeTurn>, StorageError> {
        self.storage
            .execute(move |db| {
                db.query_row(
            "SELECT turn_id,semantic_state,trigger_key,original_message_id,original_message \
             FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
            [session],
            |row| Ok(StoredSubsessionResumeTurn {
                turn_id: row.get(0)?, semantic_state: row.get(1)?, original_event_id: row.get(2)?,
                original_message_id: row.get(3)?, original_message: row.get(4)?,
            }),
        ).optional().map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn admitted_turn_matches(
        &self,
        session: String,
        turn: String,
        message: String,
    ) -> Result<bool, StorageError> {
        self.storage.execute(move |db| {
            let present=db.query_row("SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND session_id=?2 AND original_message_id=?3",params![turn,session,message],|_|Ok(())).optional().map_err(StorageError::sqlite)?.is_some();
            Ok(present)
        }).await
    }

    pub(crate) async fn result_for_relation(
        &self,
        relation: String,
    ) -> Result<Option<Value>, StorageError> {
        self.storage.execute(move |db| db.query_row("SELECT result_id,child_turn_id,status,summary,acceptance_evidence_json,created_at FROM btcc_steward_results WHERE relation_id=?1 ORDER BY created_at DESC LIMIT 1",[relation],|r| {
            let evidence:String=r.get(4)?;
            Ok(serde_json::json!({"result_id":r.get::<_,String>(0)?,"child_turn_id":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"summary":r.get::<_,String>(3)?,"acceptance_evidence":serde_json::from_str::<Value>(&evidence).unwrap_or(Value::Array(vec![])),"created_at":r.get::<_,String>(5)?}))
        }).optional().map_err(StorageError::sqlite)).await
    }

    pub(crate) async fn open_relation_by_work(
        &self,
        work: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| {
                let status: Option<String> = db
                    .query_row(
                        "SELECT status FROM btcc_guided_works WHERE work_id=?1",
                        [&work],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?;
                if !matches!(status.as_deref(), Some("open" | "blocked")) {
                    return Ok(None);
                }
                read(db, "d.root_work_id=?1", &work)
            })
            .await
    }

    pub(crate) async fn mark_enqueued(&self, relation: String) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            db.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1",[relation]).map_err(StorageError::sqlite)?;
            Ok(())
        }).await
    }

    pub(crate) async fn pending_dispatches(
        &self,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| {
                let mut statement = db
                    .prepare(&format!(
                        "{} WHERE d.dispatch_state='pending' ORDER BY r.created_at",
                        SELECT
                    ))
                    .map_err(StorageError::sqlite)?;
                let rows = statement.query_map([], row).map_err(StorageError::sqlite)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn has_active_child(&self, parent: String) -> Result<bool, StorageError> {
        self.storage
            .execute(move |db| {
                let count: i64 = db
                    .query_row(
                        "SELECT COUNT(*) FROM btcc_session_relations r LEFT JOIN btcc_steward_results x ON x.relation_id=r.relation_id WHERE r.parent_session_id=?1 AND x.result_id IS NULL",
                        [parent],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::sqlite)?;
                Ok(count > 0)
            })
            .await
    }

    pub(crate) async fn child_result_evidence(
        &self,
        parent: String,
    ) -> Result<Vec<String>, StorageError> {
        self.storage
            .execute(move |db| {
                let mut statement = db.prepare("SELECT x.acceptance_evidence_json FROM btcc_session_relations r JOIN btcc_steward_results x ON x.relation_id=r.relation_id WHERE r.parent_session_id=?1 AND x.status='success' ORDER BY x.created_at,x.result_id").map_err(StorageError::sqlite)?;
                let rows = statement
                    .query_map([parent], |row| row.get::<_, String>(0))
                    .map_err(StorageError::sqlite)?;
                let mut evidence = Vec::new();
                for encoded in rows {
                    let refs: Vec<String> = serde_json::from_str(&encoded.map_err(StorageError::sqlite)?)
                        .map_err(|error| StorageError::new("subsession_result_invalid", error.to_string()))?;
                    evidence.extend(refs);
                }
                evidence.sort();
                evidence.dedup();
                Ok(evidence)
            })
            .await
    }

    pub(crate) async fn commit_result(
        &self,
        child_session: String,
        child_turn: String,
        status: String,
        summary: String,
        evidence_refs: Vec<String>,
        now: String,
    ) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            let delegation = read(db,"r.child_session_id=?1",&child_session)?.ok_or_else(|| StorageError::new("subsession_relation_missing","Subsession relation is missing"))?;
            let result_id = format!("result-{}", crate::btcc::digest_identity(&format!("btcc.subsession.result.v1\0{child_session}\0{child_turn}")));
            let packet = delegation.packet.as_object().ok_or_else(|| StorageError::new("subsession_packet_invalid","Subsession packet is invalid"))?;
            let model = packet.get("model_ref").and_then(Value::as_str).unwrap_or("");
            let reasoning = packet.get("reasoning_effort").and_then(Value::as_str).unwrap_or("");
            let access = required_packet_string(packet, "access_mode")?;
            let child_role = required_packet_string(packet, "child_role")?;
            let parent_chat = packet.get("parent_chat_id").and_then(Value::as_str);
            if model.is_empty() || reasoning.is_empty() { return Err(StorageError::new("subsession_parent_model_context_missing","Subsession model context is missing")); }
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let evidence_json=serde_json::to_string(&evidence_refs).map_err(|e|StorageError::new("subsession_result_invalid",e.to_string()))?;
            tx.execute("INSERT OR IGNORE INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8,'[]',?9)",params![result_id,delegation.relation_id,delegation.task_id,child_session,child_turn,status,summary,evidence_json,now]).map_err(StorageError::sqlite)?;
            let text = format!("Delegated result\nstatus: {status}\nsummary: {summary}\nevidence_refs: {evidence_json}");
            let input = match child_role {
                "worker" => serde_json::json!({
                    "route":"steward_queue","text":text,"model_ref":model,
                    "reasoning_effort":reasoning,"timestamp":now,
                }),
                "steward" => serde_json::json!({
                    "route":"butler_app","relation_id":delegation.relation_id,
                    "result_id":result_id,"parent_session_id":delegation.parent_session_id,
                    "parent_turn_id":delegation.parent_turn_id,
                    "parent_chat_id":parent_chat.ok_or_else(|| StorageError::new("parent_app_binding_required","Parent App binding is missing"))?,
                    "message_id":format!("subsession-result-message:{result_id}"),
                    "safe_title":"Delegated result","text":text,"model_ref":model,
                    "reasoning_effort":reasoning,"access_mode":access,"timestamp":now,
                }),
                _ => return Err(StorageError::new("subsession_child_role_invalid","Subsession child role is invalid")),
            };
            tx.execute("INSERT OR IGNORE INTO btcc_subsession_outbox (outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)",params![format!("outbox-{result_id}"),delegation.relation_id,result_id,delegation.parent_session_id,delegation.parent_turn_id,format!("subsession-result-message:{result_id}"),input.to_string(),now]).map_err(StorageError::sqlite)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(())
        }).await
    }

    pub(crate) async fn pending_parent_inputs(
        &self,
    ) -> Result<Vec<PendingParentInput>, StorageError> {
        self.storage.execute(move |db| {
            let mut statement=db.prepare("SELECT result_id,parent_session_id,input_json FROM btcc_subsession_outbox WHERE status='pending' ORDER BY created_at").map_err(StorageError::sqlite)?;
            let rows=statement.query_map([],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).map_err(StorageError::sqlite)?;
            rows.map(|value| {
                let (result_id,parent_session_id,encoded)=value.map_err(StorageError::sqlite)?;
                let input:Value=serde_json::from_str(&encoded).map_err(|e|StorageError::new("subsession_outbox_invalid",e.to_string()))?;
                let route=match input.get("route").and_then(Value::as_str) {
                    Some("steward_queue")=>ParentResultRoute::StewardQueue,
                    Some("butler_app")=>ParentResultRoute::ButlerApp,
                    _=>return Err(StorageError::new("subsession_outbox_route_invalid","Subsession outbox route is invalid")),
                };
                Ok(PendingParentInput{result_id,parent_session_id,route,input})
            }).collect()
        }).await
    }

    pub(crate) async fn mark_delivered(
        &self,
        result: String,
        now: String,
    ) -> Result<(), StorageError> {
        self.storage.execute(move|db| { db.execute("UPDATE btcc_subsession_outbox SET status='delivered',delivered_at=?2 WHERE result_id=?1 AND status='pending'",params![result,now]).map_err(StorageError::sqlite)?; Ok(()) }).await
    }
}

const SELECT: &str = "SELECT r.relation_id,d.delegation_id,d.task_id,r.parent_session_id,r.parent_turn_id,r.child_session_id,d.child_turn_id,d.root_work_id,d.packet_json,d.dispatch_intent_json,r.anchor_message_id,r.ordinal,r.safe_title,r.created_at FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id";
fn read(
    db: &rusqlite::Connection,
    predicate: &str,
    value: &str,
) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
    db.query_row(&format!("{SELECT} WHERE {predicate}"), [value], row)
        .optional()
        .map_err(StorageError::sqlite)
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSubsessionDelegation> {
    let packet: String = row.get(8)?;
    let dispatch: String = row.get(9)?;
    let packet = serde_json::from_str(&packet).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let dispatch_intent = serde_json::from_str(&dispatch).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(StoredSubsessionDelegation {
        relation_id: row.get(0)?,
        delegation_id: row.get(1)?,
        task_id: row.get(2)?,
        parent_session_id: row.get(3)?,
        parent_turn_id: row.get(4)?,
        child_session_id: row.get(5)?,
        child_turn_id: row.get(6)?,
        root_work_id: row.get(7)?,
        packet,
        dispatch_intent,
        anchor_message_id: row.get(10)?,
        ordinal: row.get(11)?,
        safe_title: row.get(12)?,
        created_at: row.get(13)?,
    })
}

fn direction_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSubsessionDirection> {
    Ok(StoredSubsessionDirection {
        instruction_id: row.get(0)?,
        relation_id: row.get(1)?,
        revision: row.get(2)?,
        instruction: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn required_packet_string<'a>(
    packet: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, StorageError> {
    packet
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            StorageError::new(
                "subsession_packet_invalid",
                format!("Subsession packet is missing {key}"),
            )
        })
}
