use serde_json::json;

use super::{is_activity, work_blocks::project};

#[test]
fn work_blocks_merge_tool_updates_and_exclude_internal_tools() {
    let blocks = project(&[
        json!({
            "id":"start", "kind":"work_block", "work_block_id":"block-1",
            "work_block_label":"Inspect", "work_block_phase":"started",
            "safe_label":"Inspect", "state":"running", "turn_event_sequence":1
        }),
        json!({
            "id":"tool-1", "kind":"read", "work_block_id":"block-1",
            "tool_call_id":"call-1", "safe_tool_name":"read_file",
            "safe_label":"Read source", "state":"running", "turn_event_sequence":2
        }),
        json!({
            "id":"tool-2", "kind":"read", "work_block_id":"block-1",
            "tool_call_id":"call-1", "safe_tool_name":"read_file",
            "safe_label":"Read source", "state":"completed", "turn_event_sequence":3
        }),
        json!({
            "id":"internal", "kind":"used_tool", "work_block_id":"block-1",
            "tool_call_id":"call-2", "safe_tool_name":"Update Todo List",
            "safe_label":"Update Todo List", "state":"completed"
        }),
        json!({
            "id":"end", "kind":"work_block", "work_block_id":"block-1",
            "work_block_label":"Inspect", "work_block_phase":"completed",
            "safe_label":"Inspect", "state":"delivered", "turn_event_sequence":4
        }),
    ]);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["state"], "delivered");
    assert_eq!(blocks[0]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(blocks[0]["rows"][0]["state"], "completed");
    assert_eq!(blocks[0]["rows"][0]["turn_event_sequence"], 2.0);
    // Source object rest retains the original property order after removing
    // work-block metadata; this also governs serialized public row bytes.
    assert_eq!(
        blocks[0]["rows"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "id",
            "kind",
            "tool_call_id",
            "safe_tool_name",
            "safe_label",
            "state",
            "turn_event_sequence"
        ],
    );
}

#[test]
fn empty_or_null_legacy_fields_do_not_create_blocks_or_panic() {
    let blocks = project(&[
        json!({
            "id":"empty-id", "kind":"message", "work_block_id":"",
            "work_block_label":"Visible", "safe_label":"Visible", "state":"running"
        }),
        json!({
            "id":"empty-label", "kind":"message", "work_block_id":"block",
            "work_block_label":"", "safe_label":"Visible", "state":"running"
        }),
        json!({
            "id":"null-fields", "kind":"message", "work_block_id":null,
            "work_block_label":null, "safe_label":"Visible", "state":"running"
        }),
    ]);
    assert!(blocks.is_empty());
}

#[test]
fn activity_projection_uses_javascript_truthiness_for_optional_strings() {
    let empty_operation = json!({
        "kind":"used_tool", "bridge_phase":"btcc_operation", "semantic_block_id":""
    });
    let null_block_decision = json!({
        "kind":"message", "work_block_id":null, "semantic_block_id":"semantic-1",
        "work_decision_source":"model-authored", "work_decision_summary":"Decision"
    });
    assert!(!is_activity(&empty_operation));
    assert!(is_activity(&null_block_decision));
}
