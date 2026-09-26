use serde_json::{Map, Value, json};

use super::authority::{SessionWorkspaceAuthority, resolve_authority};
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

#[test]
fn absent_null_and_empty_project_paths_keep_distinct_authority() {
    let stored = binding(None);
    assert_eq!(
        resolve_authority(Some(&stored), None),
        SessionWorkspaceAuthority::Project {
            workspace_path: Some("/stored".into())
        }
    );
    assert_eq!(
        resolve_authority(Some(&stored), Some("")),
        SessionWorkspaceAuthority::Project {
            workspace_path: Some(String::new())
        }
    );
    let invalid = binding(Some(Map::from_iter([(
        "sessionWorkspace".into(),
        json!(null),
    )])));
    assert!(matches!(
        resolve_authority(Some(&invalid), Some("/project")),
        SessionWorkspaceAuthority::Unavailable { workspace_path, .. } if workspace_path == "/stored"
    ));
}
