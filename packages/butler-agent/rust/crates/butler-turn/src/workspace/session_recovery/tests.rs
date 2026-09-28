use serde_json::{Map, Value};

use crate::workspace::{SessionLifecycleState, SessionRole, StoredSessionBinding};

mod integration;
mod lifecycle;
mod oracle;

fn binding(metadata: Option<Map<String, Value>>) -> StoredSessionBinding {
    StoredSessionBinding {
        session_id: "session".into(),
        role: SessionRole::Butler,
        lifecycle_state: SessionLifecycleState::Active,
        project_id: None,
        app_project_id: None,
        ledger_project_id: None,
        workspace_path: "/stored".into(),
        runtime_adapter_id: String::new(),
        model_provider_id: String::new(),
        model_ref: String::new(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: Vec::new(),
        created_at: String::new(),
        updated_at: String::new(),
        last_active_at: None,
        metadata,
    }
}
