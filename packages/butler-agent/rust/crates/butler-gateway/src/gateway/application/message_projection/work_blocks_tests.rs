use serde_json::json;

use super::work_blocks::project;

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
