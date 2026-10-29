//! Canon port over the existing BTCC storage lanes.
use super::{ApplicationFuture, GatewayApplicationError};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppCanonResource {
    Canon,
    List,
    Spec,
    Activity,
    Comment,
    ProposeSpec,
    Grants,
    AllowGrant,
    DenyGrant,
    RevokeGrant,
    Plan,
    Epic,
    EpicProgress,
    CreatePlan,
    EditPlan,
    CreateEpic,
    EditEpic,
    PlanOrder,
    BacklogOrder,
    Tags,
    CreateTag,
    EditTag,
    DeleteTag,
}

#[derive(Clone, Debug)]
pub struct AppCanonRequest {
    pub resource: AppCanonResource,
    pub id: String,
    pub input: Option<Value>,
    pub delegate: Option<AppCanonDelegate>,
}
#[derive(Clone, Debug)]
pub struct AppCanonDelegate {
    pub name: String,
    pub title: String,
}
#[derive(Clone, Debug)]
pub struct AppCanonEvent {
    pub seq: i64,
    pub topic: String,
    pub payload: Value,
}
#[derive(Debug, thiserror::Error)]
#[error("work model revision conflict")]
pub struct AppCanonConflict {
    pub revision: i64,
}

#[derive(Debug, thiserror::Error)]
#[error("tag already exists")]
pub struct AppCanonTagExists {
    pub existing: Value,
}

pub const APP_PERSON_ID: &str = "app-user";

#[derive(Clone, Debug)]
pub enum AppCanonOperation {
    Queue {
        session_id: String,
        action: String,
        input: Value,
    },
    StepTurnEnded {
        op_id: String,
        outcome: String,
    },
    SessionDeleted {
        session_hint: String,
        op_id: String,
    },
    BoundSessions,
    Link {
        work_id: String,
        session_id: Option<String>,
        new_session_id: String,
    },
    PendingQueue,
    Pending {
        after: String,
    },
    Applied {
        op_id: String,
        revision: i64,
    },
}

pub trait AppCanonPort: Send + Sync + 'static {
    fn admit(&self, _delegate: AppCanonDelegate, _capability: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn proposal(&self, action: String, _input: Value) -> ApplicationFuture<Value> {
        Box::pin(async move {
            if matches!(action.as_str(), "open" | "turns" | "attention") {
                Ok(serde_json::json!([]))
            } else {
                Err(GatewayApplicationError::internal())
            }
        })
    }
    fn canon_operation(&self, _operation: AppCanonOperation) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn session_epics(&self, sessions: Vec<String>) -> ApplicationFuture<Vec<Vec<String>>> {
        Box::pin(async move { Ok(sessions.into_iter().map(|_| Vec::new()).collect()) })
    }
    fn execute(&self, _request: AppCanonRequest) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Indexed identity lookup only; never constructs an inspector or its cards.
    fn project_scope(&self, _resource: AppCanonResource, _id: String) -> ApplicationFuture<String> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        None
    }
    fn reconcile(&self) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn unpublished(&self, _after: i64) -> ApplicationFuture<Vec<AppCanonEvent>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn published(&self, _seqs: Vec<i64>) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}
#[derive(Default)]
pub struct UnavailableCanon;
impl AppCanonPort for UnavailableCanon {}
