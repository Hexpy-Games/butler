//! Durable subsession state on the existing BTCC SQLite owner.

mod activity;
mod completion;
mod decode;
mod files;
mod records;

pub use records::*;

use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use self::decode::{direction_row, list, read, required_packet_string};
use super::{BtccStorage, StorageError};
use crate::btcc::StorageCode;

/// A new subsession delegation to persist.
#[derive(Clone, Debug)]
pub struct SubsessionCreate {
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
    pub packet: SubsessionPacket,
    pub dispatch_intent: DispatchIntent,
    pub created_at: String,
}

/// A persisted subsession delegation.
#[derive(Clone, Debug)]
pub struct StoredSubsessionDelegation {
    pub relation_id: String,
    pub delegation_id: String,
    pub task_id: String,
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub child_session_id: String,
    pub child_turn_id: String,
    pub root_work_id: String,
    pub packet: SubsessionPacket,
    /// Absent on delegations created before dispatch intents were stored.
    pub dispatch_intent: Option<DispatchIntent>,
    pub anchor_message_id: String,
    pub ordinal: i64,
    pub safe_title: String,
    pub created_at: String,
}

/// Both relation lookups for one App projection share the same WAL snapshot.
pub(crate) struct SessionRelations {
    pub children: Vec<StoredSubsessionDelegation>,
    pub own: super::StorageResult<Option<StoredSubsessionDelegation>>,
}

/// A direction sent to a subsession.
#[derive(Clone, Debug)]
pub struct StoredSubsessionDirection {
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
pub struct PendingParentInput {
    pub result_id: String,
    pub parent_session_id: String,
    pub route: ParentResultRoute,
    pub input: ParentResultInput,
}

/// Where a child result is delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParentResultRoute {
    StewardQueue,
    ButlerApp,
}

/// The SQLite subsession store.
#[derive(Clone)]
pub struct SqliteSubsessionRepository {
    pub(super) storage: BtccStorage,
}

/// One atomic child closeout, including its typed parent continuation.
pub(crate) struct ChildCompletion {
    pub session: String,
    pub turn: String,
    pub status: String,
    pub summary: String,
    pub failure_reason: Option<String>,
    pub failure_code: Option<String>,
    pub evidence_refs: Vec<String>,
    pub handoff: Option<crate::btcc::CapabilityHandoff>,
}

impl SqliteSubsessionRepository {
    /// A repository over the store.
    pub fn new(storage: BtccStorage) -> Self {
        Self { storage }
    }

    pub(crate) async fn create(&self, input: SubsessionCreate) -> Result<bool, StorageError> {
        let encode = |error: serde_json::Error| {
            StorageError::new(StorageCode::SubsessionPacketInvalid, error.to_string())
                .with_source(error)
        };
        let packet_json = serde_json::to_string(&input.packet).map_err(encode)?;
        let intent_json = serde_json::to_string(&input.dispatch_intent).map_err(encode)?;
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
                    params![input.delegation_id,input.relation_id,input.task_id,input.child_turn_id,input.root_work_id,packet_json,intent_json,input.created_at],
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
            .read(move |db| read(db, "d.delegation_id=?1", &id))
            .await
    }

    pub(crate) async fn by_child(
        &self,
        id: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .read(move |db| read(db, "r.child_session_id=?1", &id))
            .await
    }

    pub(crate) async fn relation_by_id(
        &self,
        id: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .read(move |db| read(db, "r.relation_id=?1", &id))
            .await
    }

    pub(crate) async fn projection_relations(
        &self,
        session: String,
    ) -> super::StorageResult<SessionRelations> {
        self.storage
            .read(move |db| {
                let children = list(
                    db,
                    "WHERE r.parent_session_id=?1 ORDER BY r.ordinal",
                    [&session],
                )?;
                // Preserve the caller's handling of an undecodable own relation.
                let own = read(db, "r.child_session_id=?1", &session);
                Ok(SessionRelations { children, own })
            })
            .await
    }

    /// The parent's delegations.
    pub async fn relations_for_parent(
        &self,
        parent: String,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .read(move |db| {
                list(
                    db,
                    "WHERE r.parent_session_id=?1 ORDER BY r.ordinal",
                    [parent],
                )
            })
            .await
    }

    pub(crate) async fn latest_relation_for_parent(
        &self,
        parent: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| {
                Ok(list(
                    db,
                    "WHERE r.parent_session_id=?1 ORDER BY r.ordinal DESC LIMIT 1",
                    [parent],
                )?
                .pop())
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
        self.storage.execute(move |db| db.query_row(
            "SELECT r.result_id,r.child_turn_id,r.status,r.summary,r.acceptance_evidence_json,r.created_at,t.final_payload_json \
             FROM btcc_steward_results r LEFT JOIN btcc_turns t ON t.turn_id=r.child_turn_id \
             WHERE r.relation_id=?1 ORDER BY r.created_at DESC LIMIT 1", [relation], |r| {
                let evidence: String = r.get(4)?;
                let mut result = serde_json::json!({"result_id":r.get::<_,String>(0)?,"child_turn_id":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"summary":r.get::<_,String>(3)?,"acceptance_evidence":serde_json::from_str::<Value>(&evidence).unwrap_or(Value::Array(vec![])),"created_at":r.get::<_,String>(5)?});
                let payload = r.get::<_, Option<String>>(6)?
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
                if let Some(payload) = payload {
                    super::subsession_result::project_delivery(&mut result, &payload);
                }
                Ok(result)
            }).optional().map_err(StorageError::sqlite)).await
    }

    pub(crate) async fn relation_by_work(
        &self,
        work: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| read(db, "d.root_work_id=?1", &work))
            .await
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
        self.storage.execute(decode::pending).await
    }

    /// Whether the parent has a child without a result.
    pub async fn has_active_child(&self, parent: String) -> Result<bool, StorageError> {
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
                        .map_err(|error| StorageError::new(StorageCode::SubsessionResultInvalid, error.to_string()).with_source(error))?;
                    evidence.extend(refs);
                }
                evidence.sort();
                evidence.dedup();
                Ok(evidence)
            })
            .await
    }

    /// Child results waiting to be delivered to parents.
    pub async fn pending_parent_inputs(&self) -> Result<Vec<PendingParentInput>, StorageError> {
        self.storage.execute(move |db| {
            let mut statement=db.prepare("SELECT result_id,parent_session_id,input_json FROM btcc_subsession_outbox WHERE status='pending' ORDER BY created_at").map_err(StorageError::sqlite)?;
            let rows=statement.query_map([],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).map_err(StorageError::sqlite)?;
            rows.map(|value| {
                let (result_id,parent_session_id,encoded)=value.map_err(StorageError::sqlite)?;
                let invalid=|e: serde_json::Error| StorageError::new(StorageCode::SubsessionOutboxInvalid,e.to_string()).with_source(e);
                let tag:RouteTag=serde_json::from_str(&encoded).map_err(invalid)?;
                let route=match tag.route {
                    Some(OutboxRoute::StewardQueue)=>ParentResultRoute::StewardQueue,
                    Some(OutboxRoute::ButlerApp)=>ParentResultRoute::ButlerApp,
                    Some(OutboxRoute::Unknown) | None=>return Err(StorageError::new(StorageCode::SubsessionOutboxRouteInvalid,"Subsession outbox route is invalid")),
                };
                let input=serde_json::from_str(&encoded).map_err(invalid)?;
                Ok(PendingParentInput{result_id,parent_session_id,route,input})
            }).collect()
        }).await
    }

    /// Marks a child result delivered.
    pub async fn mark_delivered(&self, result: String, now: String) -> Result<(), StorageError> {
        self.storage.execute(move|db| { db.execute("UPDATE btcc_subsession_outbox SET status='delivered',delivered_at=?2 WHERE result_id=?1 AND status='pending'",params![result,now]).map_err(StorageError::sqlite)?; Ok(()) }).await
    }
}

const SELECT: &str = "SELECT r.relation_id,d.delegation_id,d.task_id,r.parent_session_id,r.parent_turn_id,r.child_session_id,d.child_turn_id,d.root_work_id,d.packet_json,d.dispatch_intent_json,r.anchor_message_id,r.ordinal,r.safe_title,r.created_at FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id";
