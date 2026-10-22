use super::child_metadata;
use crate::workspace::{SessionLifecycleState, SessionRole, StoredSessionBinding};
use serde_json::json;

fn binding(role: SessionRole, metadata: &serde_json::Value) -> StoredSessionBinding {
    StoredSessionBinding {
        session_id: "session".into(),
        role,
        lifecycle_state: SessionLifecycleState::Active,
        project_id: Some("app-project".into()),
        app_project_id: Some("app-project".into()),
        ledger_project_id: Some("ledger-project".into()),
        workspace_path: "/tmp/workspace".into(),
        runtime_adapter_id: "test-runtime".into(),
        model_provider_id: "provider".into(),
        model_ref: "provider/model".into(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: Vec::new(),
        created_at: "now".into(),
        updated_at: "now".into(),
        last_active_at: None,
        metadata: metadata.as_object().cloned(),
    }
}

// test-category: pure-logic
#[test]
fn steward_child_inherits_normalized_runtime_policy_while_worker_stays_local() {
    let parent = binding(
        SessionRole::Butler,
        &json!({"runtimePolicy":{
            "accessMode":"ask_first",
            "tracking_mode":"ledger",
            "requiredNativeTools":null,
            "required_tools":[" query_memory ","query_memory","read_file"],
            "requiredNativeToolProfiles":["memory-read"],
            "customPolicy":"preserved"
        }}),
    );
    let packet =
        crate::btcc::SubsessionPacket::fixture(crate::btcc::ChildRole::Steward, "Complete task.");
    let steward = child_metadata(
        crate::btcc::ChildRole::Steward,
        &packet,
        "read_only",
        &parent,
    );
    let policy = &steward["runtimePolicy"];
    assert_eq!(policy["accessMode"], "read_only");
    assert_eq!(policy["trackingMode"], "ledger");
    assert_eq!(policy["tracking_mode"], "ledger");
    assert_eq!(
        policy["requiredNativeTools"],
        json!(["query_memory", "read_file"])
    );
    assert_eq!(
        policy["required_tools"],
        json!(["query_memory", "read_file"])
    );
    assert_eq!(policy["requiredNativeToolProfiles"], json!(["memory-read"]));
    assert_eq!(policy["authoritySource"], "parent_session");
    assert_eq!(policy["authority_source"], "parent_session");
    assert_eq!(policy["customPolicy"], "preserved");

    let worker = child_metadata(
        crate::btcc::ChildRole::Worker,
        &packet,
        "full_access",
        &parent,
    );
    let policy = &worker["runtimePolicy"];
    assert_eq!(policy["trackingMode"], "local");
    assert_eq!(policy["tracking_mode"], "local");
    assert_eq!(policy["requiredNativeTools"], json!([]));
    assert_eq!(policy["required_tools"], json!([]));
    assert_eq!(policy["requiredNativeToolProfiles"], json!(["workspace"]));
    assert!(policy.get("customPolicy").is_none());
}

pub(crate) fn delegation_identities_are_byte_stable() {
    let identity = json!(["parent", "turn", "part", "request"]);
    for naming in [&super::delegation::STEWARD, &super::delegation::WORKER] {
        let id = super::delegation::delegation_id(naming, &identity).unwrap();
        assert_eq!(
            id,
            super::delegation::delegation_id(naming, &identity).unwrap()
        );
        assert_ne!(
            id,
            super::delegation::delegation_id(
                naming,
                &json!(["parent", "turn", "other", "request"])
            )
            .unwrap()
        );
    }
}
