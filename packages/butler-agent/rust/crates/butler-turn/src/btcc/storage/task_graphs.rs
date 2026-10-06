//! Indexed, snapshot-consistent reads of existing plans and delegation groups.
mod query;
use super::{SqliteSubsessionRepository, StorageError};
use serde_json::Value;

#[derive(Clone, Debug)]
pub enum GraphScope {
    Session(String),
    Plan(String),
    Task(String),
}

pub struct GraphRecords {
    pub plans: Vec<PlanRecord>,
    pub children: Vec<ChildRecord>,
}

pub struct PlanRecord {
    pub id: String,
    pub objective: String,
    pub status: String,
    pub actions: Value,
    pub checks: Value,
    pub refs: Value,
    pub progress: Value,
    pub updated_at: String,
}

pub struct ChildRecord {
    pub task_id: String,
    pub parent_session: String,
    pub parent_turn: String,
    pub session_id: String,
    pub turn_id: String,
    pub ordinal: i64,
    pub title: String,
    pub packet: Value,
    pub result_status: Option<String>,
    pub result_at: Option<String>,
    pub turn_state: Option<String>,
    pub created_at: String,
    pub current_step: Option<String>,
    pub stage: Option<String>,
}

impl SqliteSubsessionRepository {
    /// One WAL snapshot; two set-based queries, never one query per node/graph.
    pub async fn graph_records(&self, scope: GraphScope) -> Result<GraphRecords, StorageError> {
        self.storage.read(move |db| query::read(db, scope)).await
    }
}

impl SqliteSubsessionRepository {
    pub async fn graph_change_watermark(&self) -> Result<i64, StorageError> {
        self.storage
            .read(|db| {
                db.query_row(
                    "SELECT COALESCE(MAX(seq),0) FROM agent_task_graph_changes",
                    [],
                    |r| r.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }
    pub fn graph_change_signal(&self) -> tokio::sync::watch::Receiver<()> {
        self.storage.subscribe_changes()
    }
    /// Indexed coalesced changes after an in-memory reader watermark.
    pub async fn graph_changes_after(
        &self,
        after: i64,
    ) -> Result<Vec<(i64, String)>, StorageError> {
        self.storage
            .read(move |db| {
                db.prepare_cached(
                    "WITH RECURSIVE changed(seq,session_id) AS (SELECT seq,session_id FROM agent_task_graph_changes WHERE seq>?1 UNION SELECT c.seq,r.parent_session_id FROM changed c JOIN btcc_session_relations r ON r.child_session_id=c.session_id) SELECT seq,session_id FROM changed ORDER BY seq,session_id",
                )
                .map_err(StorageError::sqlite)?
                .query_map([after], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(StorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::sqlite)
            })
            .await
    }
}
