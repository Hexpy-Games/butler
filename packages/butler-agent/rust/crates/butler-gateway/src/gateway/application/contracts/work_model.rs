//! Local work-model port; the gateway never owns a BTCC connection.
//!
//! Task structure edits use `{ops:[{op,...}], expected_task_graph_revision:rev}`.
//! The Work graph token is checked before any edit; the entire request rolls back
//! on failure. `start_now` creates a ready root; runtime execution is admitted
//! by the session execution owner when the runtime stack is enabled.
//!
//! Canon order requests require every destination card in `work_ids` exactly
//! once. Plan order CAS uses the Plan revision; backlog CAS uses the project's
//! `backlog_revision` returned by GET canon, passed as `expected_revision`.
//! Membership changes also advance these tokens. Inspector activity is absent
//! until a canon activity table exists; Tasks support structure edits. Terminal epic
//! status edits require `expected_task_graph_revision` from the Work.
use super::{ApplicationFuture, GatewayApplicationError};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppWorkModelResource {
    Queue,
    Canon,
    Plan,
    Epic,
    CreatePlan,
    EditPlan,
    CreateEpic,
    EditEpic,
    PlanOrder,
    BacklogOrder,
    Sidebar,
    SidebarOrder,
    Conversation,
}

#[derive(Clone, Debug)]
pub struct AppWorkModelRequest {
    pub resource: AppWorkModelResource,
    pub id: String,
    pub input: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct AppWorkModelEvent {
    pub seq: i64,
    pub topic: String,
    pub payload: Value,
}
#[derive(Debug, thiserror::Error)]
#[error("work model revision conflict")]
pub struct AppWorkModelConflict {
    pub revision: i64,
}

#[derive(Clone, Debug)]
pub enum AppWorkModelScope {
    Project(String),
    Session(String),
}

pub const APP_PERSON_ID: &str = "app-user";

#[derive(Clone, Debug)]
pub enum AppCanonOperation {
    Link { work_id: String, session_id: String },
    Pending { after: String },
    Applied { op_id: String, revision: i64 },
}

pub trait AppWorkModelPort: Send + Sync + 'static {
    fn canon_operation(&self, _operation: AppCanonOperation) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn execute(&self, _request: AppWorkModelRequest) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Indexed identity lookup only; never constructs an inspector or its cards.
    fn project_scope(
        &self,
        _resource: AppWorkModelResource,
        _id: String,
    ) -> ApplicationFuture<String> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Work identity only, resolved by primary key on the BTCC read lane.
    fn work_scope(&self, _id: String) -> ApplicationFuture<AppWorkModelScope> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        None
    }
    fn unpublished(&self, _after: i64) -> ApplicationFuture<Vec<AppWorkModelEvent>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn published(&self, _seqs: Vec<i64>) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}
#[derive(Default)]
pub struct UnavailableWorkModel;
impl AppWorkModelPort for UnavailableWorkModel {}
