use serde_json::json;

use super::rows::public_rows;

#[test]
fn semantic_tool_updates_merge_and_terminal_states_propagate() {
    let rows = public_rows(
        vec![
            json!({
                "id":"legacy", "kind":"read", "safe_label":"Read source",
                "safe_tool_name":"read_file", "safe_input_label":"src/lib.rs",
                "state":"running", "turn_event_sequence":2
            }),
            json!({
                "id":"native", "kind":"read", "safe_label":"Read source",
                "safe_tool_name":"read_file", "safe_input_label":"src/lib.rs",
                "tool_call_id":"call-1", "state":"completed", "turn_event_sequence":3
            }),
        ],
        "delivered",
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["tool_call_id"], "call-1");
    assert_eq!(rows[0]["state"], "completed");
    assert_eq!(rows[0]["turn_event_sequence"], 2.0);
}

#[test]
fn terminal_projection_hides_first_progress_and_stops_active_work_task() {
    let rows = public_rows(
        vec![
            json!({
                "id":"first", "kind":"work_block", "safe_label":"Starting",
                "work_block_id":"first-progress-1", "state":"running"
            }),
            json!({
                "id":"task", "kind":"todo", "safe_label":"Task",
                "bridge_phase":"btcc_work_ledger", "state":"active",
                "safe_detail_rows":[{"id":"detail","safe_label":"Review","state":"reviewing"}]
            }),
        ],
        "failed",
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["state"], "stopped");
    assert_eq!(rows[0]["safe_detail_rows"][0]["state"], "cancelled");
}
