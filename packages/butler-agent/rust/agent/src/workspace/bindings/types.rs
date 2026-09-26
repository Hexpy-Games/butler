use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionRole {
    Butler,
    Steward,
    Worker,
    Unknown(String),
}

impl SessionRole {
    pub(super) fn as_str(&self) -> &str {
        match self {
            Self::Butler => "butler",
            Self::Steward => "steward",
            Self::Worker => "worker",
            Self::Unknown(value) => value,
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        match value {
            "butler" => Self::Butler,
            "steward" => Self::Steward,
            "worker" => Self::Worker,
            _ => Self::Unknown(value.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionLifecycleState {
    Active,
    Closing,
    Closed,
    Crashed,
    Unknown(String),
}

impl SessionLifecycleState {
    pub(super) fn as_str(&self) -> &str {
        match self {
            Self::Active => "active",
            Self::Closing => "closing",
            Self::Closed => "closed",
            Self::Crashed => "crashed",
            Self::Unknown(value) => value,
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        match value {
            "active" => Self::Active,
            "closing" => Self::Closing,
            "closed" => Self::Closed,
            "crashed" => Self::Crashed,
            _ => Self::Unknown(value.into()),
        }
    }

    pub(super) fn is_active(&self) -> bool {
        matches!(self, Self::Active | Self::Closing)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionTransportBinding {
    pub transport: String,
    pub account_id: String,
    pub peer_id: String,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredSessionBinding {
    pub session_id: String,
    pub role: SessionRole,
    pub lifecycle_state: SessionLifecycleState,
    pub project_id: Option<String>,
    pub app_project_id: Option<String>,
    pub ledger_project_id: Option<String>,
    pub workspace_path: String,
    pub runtime_adapter_id: String,
    pub model_provider_id: String,
    pub model_ref: String,
    pub runtime_session_ref: Option<String>,
    pub provider_thread_ref: Option<String>,
    pub transport_bindings: Vec<SessionTransportBinding>,
    pub created_at: String,
    pub updated_at: String,
    pub last_active_at: Option<String>,
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum OwnOptional<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

#[derive(Clone, Debug)]
pub(crate) struct UpsertSessionBinding {
    pub session_id: String,
    pub role: SessionRole,
    pub project_id: Option<String>,
    pub app_project_id: OwnOptional<String>,
    pub ledger_project_id: OwnOptional<String>,
    pub workspace_path: String,
    pub runtime_adapter_id: String,
    pub model_provider_id: String,
    pub model_ref: String,
    pub runtime_session_ref: Option<String>,
    pub provider_thread_ref: Option<String>,
    pub transport_bindings: Vec<SessionTransportBinding>,
    pub lifecycle_state: Option<SessionLifecycleState>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_active_at: Option<String>,
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Clone, Debug)]
pub(crate) struct RebindWorkspaceInput {
    pub session_id: String,
    pub expected_updated_at: String,
    pub workspace_path: String,
    pub metadata: Map<String, Value>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ExecutionContextInput {
    pub session_id: String,
    pub expected_updated_at: String,
    pub operation_id: String,
    pub workspace_path: String,
    pub project_id: Option<String>,
    pub app_project_id: Option<String>,
    pub ledger_project_id: Option<String>,
    pub metadata: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RebindWorkspaceResult {
    Applied(StoredSessionBinding),
    Changed(Option<StoredSessionBinding>),
    Missing,
}
