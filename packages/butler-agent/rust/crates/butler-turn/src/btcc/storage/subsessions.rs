//! Durable subsession state on the existing BTCC SQLite owner.

use butler_core::json::at;
mod activity;
mod assets;
mod completion;
mod decode;
mod directions;
mod files;
mod native;
mod native_completion;
pub(crate) mod native_recovery;
mod parents;
mod records;

pub use completion::turn_result_id as subsession_result_id;
pub(crate) use directions::direction_turn_id;
pub use records::*;

use crate::btcc::subsessions::assignment::Child;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use self::decode::{list, read};
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
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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
    pub children: Vec<Child>,
    pub own: super::StorageResult<Option<Child>>,
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
    pub fn storage(&self) -> BtccStorage {
        self.storage.clone()
    }
    /// A repository over the store.
    pub fn new(storage: BtccStorage) -> Self {
        Self { storage }
    }

    pub(crate) async fn by_delegation(&self, id: String) -> Result<Option<Child>, StorageError> {
        self.storage
            .read(move |db| read(db, "d.delegation_id=?1", &id))
            .await
    }

    pub(crate) async fn by_child(&self, id: String) -> Result<Option<Child>, StorageError> {
        self.storage
            .read(move |db| read(db, "r.child_session_id=?1", &id))
            .await
    }

    pub(crate) async fn relation_by_id(&self, id: String) -> Result<Option<Child>, StorageError> {
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
    pub async fn relations_for_parent(&self, parent: String) -> Result<Vec<Child>, StorageError> {
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
    ) -> Result<Option<Child>, StorageError> {
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

    pub(crate) async fn latest_turn(
        &self,
        session: String,
    ) -> Result<Option<(String, String)>, StorageError> {
        self.storage
            .execute(move |db| {
                db.query_row(
                    crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_1,
                    [session],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn latest_resume_turn(
        &self,
        session: String,
    ) -> Result<Option<StoredSubsessionResumeTurn>, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(
                    crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_INDEXED_1,
                    [session],
                    |row| {
                        Ok(StoredSubsessionResumeTurn {
                            turn_id: row.get(0)?,
                            semantic_state: row.get(1)?,
                            original_event_id: row.get(2)?,
                            original_message_id: row.get(3)?,
                            original_message: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn admitted_turn_matches(
        &self,
        session: String,
        turn: String,
        message: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .execute(move |db| {
                let present = db
                    .query_row(
                        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_INDEXED_2,
                        params![turn, session, message],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?
                    .is_some();
                Ok(present)
            })
            .await
    }

    pub(crate) async fn result_for_relation(
        &self,
        relation: String,
    ) -> Result<Option<Value>, StorageError> {
        self.storage.execute(move |db| {
            if let Some(result) = native::result(db, &relation)? { return Ok(Some(result)); }
            db.query_row(
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
            }).optional().map_err(StorageError::sqlite) }).await
    }

    pub(crate) async fn relation_by_work(
        &self,
        work: String,
    ) -> Result<Option<Child>, StorageError> {
        self.storage
            .execute(move |db| read(db, "d.root_work_id=?1", &work))
            .await
    }

    pub(crate) async fn open_relation(&self, child: Child) -> Result<Option<Child>, StorageError> {
        if let Child::Assigned(assigned) = &child {
            let assigned = assigned.clone();
            let open = self
                .storage
                .work_model_read(move |db| {
                    let row = if let Some(part) = &assigned.part_id {
                        butler_work::store::read_part(db, part)?
                    } else {
                        butler_work::store::read_task(db, &assigned.task_id)?
                    };
                    Ok(!matches!(
                        at(&row, "/status").as_str(),
                        Some("completed" | "cancelled")
                    ))
                })
                .await?;
            return Ok(open.then_some(child));
        }
        self.open_relation_by_work(child.root_work_id.clone()).await
    }

    pub(crate) async fn open_relation_by_work(
        &self,
        work: String,
    ) -> Result<Option<Child>, StorageError> {
        self.storage
            .read(move |db| {
                if let Some(Child::Assigned(assigned)) =
                    native::read(db, "d.root_work_id=?1", &work)?
                {
                    let task = butler_work::store::read_task(db, &assigned.task_id)
                        .map_err(super::work_model::work_error)?;
                    let open = if let Some(part) = &assigned.part_id {
                        let part = butler_work::store::read_part(db, part)
                            .map_err(super::work_model::work_error)?;
                        !matches!(
                            at(&part, "/status").as_str(),
                            Some("completed" | "cancelled")
                        )
                    } else {
                        !matches!(
                            at(&task, "/status").as_str(),
                            Some("completed" | "cancelled")
                        )
                    };
                    return Ok(open.then_some(Child::Assigned(assigned)));
                }
                let status: Option<String> = db
                    .query_row(
                        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_INDEXED_3,
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

    pub async fn pending_dispatches(
        &self,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage.execute(decode::pending).await
    }

    /// Whether the parent has a child without a result.
    pub async fn has_active_child(&self, parent: String) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                let count: i64 = db
                    .query_row(
                        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_INDEXED_4,
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
        self.storage
            .execute(move |db| {
                let mut statement = db
                    .prepare(crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_INDEXED_5)
                    .map_err(StorageError::sqlite)?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(StorageError::sqlite)?;
                rows.map(|value| {
                    let (result_id, parent_session_id, encoded) =
                        value.map_err(StorageError::sqlite)?;
                    let invalid = |e: serde_json::Error| {
                        StorageError::new(StorageCode::SubsessionOutboxInvalid, e.to_string())
                            .with_source(e)
                    };
                    let tag: RouteTag = serde_json::from_str(&encoded).map_err(invalid)?;
                    let route = match tag.route {
                        Some(OutboxRoute::StewardQueue) => ParentResultRoute::StewardQueue,
                        Some(OutboxRoute::ButlerApp) => ParentResultRoute::ButlerApp,
                        Some(OutboxRoute::Unknown) | None => {
                            return Err(StorageError::new(
                                StorageCode::SubsessionOutboxRouteInvalid,
                                "Subsession outbox route is invalid",
                            ));
                        }
                    };
                    let input = serde_json::from_str(&encoded).map_err(invalid)?;
                    Ok(PendingParentInput {
                        result_id,
                        parent_session_id,
                        route,
                        input,
                    })
                })
                .collect()
            })
            .await
    }

    /// Marks a child result delivered.
    pub async fn mark_delivered(&self, result: String, now: String) -> Result<(), StorageError> {
        self.storage
            .work_model_write(move |tx| {
                tx.execute(
                    crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_INDEXED_6,
                    params![result, now],
                )?;
                if let Some(attempt) = result.strip_prefix("result-") {
                    butler_work::store::deliver_delegated_result(
                        tx,
                        &butler_work::store::Context {
                            now: chrono::Utc::now().timestamp_millis(),
                            actor: serde_json::json!({"runtime":"delivery"}),
                        },
                        attempt,
                    )?;
                }
                Ok(())
            })
            .await
    }
}

const SELECT: &str = "SELECT r.relation_id,d.delegation_id,d.task_id,r.parent_session_id,r.parent_turn_id,r.child_session_id,d.child_turn_id,d.root_work_id,d.packet_json,d.dispatch_intent_json,r.anchor_message_id,r.ordinal,r.safe_title,r.created_at FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id";
