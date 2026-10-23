//! App subsession read and control contracts.
use super::{ApplicationFuture, GatewayApplicationError};
use serde_json::Value;

pub struct AppWorkerActivitySourcePage {
    pub children: Vec<Value>,
    pub after: Option<(String, String, String)>,
}

pub trait AppSubsessionPort: Send + Sync {
    /// Parent/child identities whose durable execution projection changed.
    fn changes(&self) -> Option<tokio::sync::broadcast::Receiver<(String, String)>> {
        None
    }

    /// Change-driven graph invalidations from canonical plan/delegation writes.
    fn graph_changes(&self) -> Option<tokio::sync::broadcast::Receiver<String>> {
        None
    }

    /// Read-only execution presence for the requested visible parent sessions.
    fn running_parents(&self, _parents: Vec<String>) -> ApplicationFuture<Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn user_work_present(&self) -> ApplicationFuture<bool> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn activity_cursor_parents(
        &self,
        _worker: String,
        _history: bool,
        _parent: Option<String>,
    ) -> ApplicationFuture<Option<Vec<String>>> {
        Box::pin(async { Ok(None) })
    }

    fn activity_page(
        &self,
        _history: bool,
        _after: Option<(String, String, String)>,
        _parent: Option<String>,
        _limit: usize,
    ) -> ApplicationFuture<Option<AppWorkerActivitySourcePage>> {
        Box::pin(async { Ok(None) })
    }
    fn task_graph_read(&self, _query: AppTaskGraphQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn projection(
        &self,
        session_id: String,
        page: Option<AppSessionViewPage>,
    ) -> ApplicationFuture<Value>;
    fn cancel(&self, parent_session_id: String, relation_id: String) -> ApplicationFuture<Value>;
    fn resume(&self, parent_session_id: String, relation_id: String) -> ApplicationFuture<Value>;
    fn read_operation_output_chunks(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
    ) -> ApplicationFuture<Vec<super::super::operation_output::OperationOutputChunk>>;
}

#[derive(Clone, Debug, Default)]
pub struct AppSessionViewPage {
    pub after_cursor: Option<u64>,
    pub before_cursor: Option<u64>,
    pub limit: usize,
}

/// Read-only graph scope, with revision-bound keyset pages.
#[derive(Clone, Debug)]
pub struct AppTaskGraphQuery {
    pub scope: butler_turn::btcc::TaskGraphScope,
    pub revision: Option<String>,
    pub cursor: Option<String>,
    pub limit: usize,
    /// Internal SSE snapshots; HTTP conversation lists remain summaries.
    pub include_nodes: bool,
}
