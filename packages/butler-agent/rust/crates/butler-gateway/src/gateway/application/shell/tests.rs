use super::command_palette;
use serde_json::json;

#[test]
fn command_palette_normalizes_query_and_preserves_source_rank() {
    let space = json!({
        "nodes": [],
        "groups": [
            {"id":"1","title":"Café","scopeProjectId":null}
        ]
    });
    let result = command_palette("café", &space, &[], &[], &[]);
    assert_eq!(result["results"][0]["kind"], "group");
    assert_eq!(result["results"][0]["title"], "Café");
}
