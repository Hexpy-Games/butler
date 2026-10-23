use serde_json::json;

use super::{child_metadata, child_work_scope};
use crate::workspace::{SessionLifecycleState, SessionRole, StoredSessionBinding};

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

#[test]
fn child_root_work_scope_uses_steward_ledger_binding_but_keeps_worker_local() {
    let steward = binding(
        SessionRole::Steward,
        &json!({"runtimePolicy":{"trackingMode":"ledger"}}),
    );
    let stored = crate::btcc::StoredSubsessionDelegation {
        relation_id: "relation".into(),
        delegation_id: "delegation".into(),
        task_id: "task".into(),
        parent_session_id: "parent".into(),
        parent_turn_id: "parent-turn".into(),
        child_session_id: steward.session_id.clone(),
        child_turn_id: "child-turn".into(),
        root_work_id: "root-work".into(),
        packet: crate::btcc::SubsessionPacket::fixture(
            crate::btcc::ChildRole::Steward,
            "Complete task.",
        ),
        dispatch_intent: Some(crate::btcc::DispatchIntent::fixture()),
        dispatch_state: crate::btcc::storage::SubsessionDispatchState::Inactive,
        anchor_message_id: "anchor".into(),
        ordinal: 1,
        safe_title: "Task".into(),
        created_at: "now".into(),
    };
    let scope = child_work_scope(&stored, &steward, "child-turn").unwrap();
    assert_eq!(scope.project_ref.as_deref(), Some("app-project"));

    let worker = binding(
        SessionRole::Worker,
        &json!({"runtimePolicy":{"trackingMode":"local"}}),
    );
    let stored = crate::btcc::StoredSubsessionDelegation {
        child_session_id: worker.session_id.clone(),
        packet: crate::btcc::SubsessionPacket::fixture(
            crate::btcc::ChildRole::Worker,
            "Complete task.",
        ),
        ..stored
    };
    let scope = child_work_scope(&stored, &worker, "child-turn").unwrap();
    assert_eq!(scope.project_ref, None);
}

mod worker_races;

/// KEEP: delegation ids are digests of these identity encodings.
pub(crate) fn delegation_identities_are_byte_stable() {
    let steward = super::helpers::StewardIdentity {
        parent_session_id: "ps",
        parent_turn_id: "pt",
        request: "req",
        work_id: "w",
        plan_revision_id: "p",
        review_revision_id: "r",
        previous_relation_id: None,
    };
    assert_eq!(
        serde_json::to_string(&steward).unwrap(),
        r#"{"parent_session_id":"ps","parent_turn_id":"pt","request":"req","work_id":"w","plan_revision_id":"p","review_revision_id":"r"}"#
    );
    let worker = super::helpers::WorkerIdentity {
        parent_session_id: "ps",
        parent_turn_id: "pt",
        action_key: "a",
        objective: "o",
        acceptance_criteria: &["c".to_owned()],
        implementation_brief: "b",
        profile_id: "id",
    };
    assert_eq!(
        serde_json::to_string(&worker).unwrap(),
        r#"{"parent_session_id":"ps","parent_turn_id":"pt","action_key":"a","objective":"o","acceptance_criteria":["c"],"implementation_brief":"b","profile_id":"id"}"#
    );
}
