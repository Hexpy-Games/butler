use super::*;

#[test]
fn large_memory_result_is_truncated_to_a_bounded_provider_preview() {
    let text = format!("{}😀{}", "A".repeat(2_366), "B".repeat(60_000));
    let output = serde_json::json!({"matches":[{"text":text}]});
    let result = ToolResult {
        tool_call_id: "call-1".into(),
        name: "query_memory".into(),
        ok: true,
        error: None,
        output: Some(JsonDocument::from_value(&output).unwrap()),
    };
    let mut original = String::from("{\"ok\":true,\"output\":{\"tool_name\":\"query_memory\",");
    let encoded = butler_core::json::stringify(&output).unwrap();
    original.push_str(&encoded[1..encoded.len() - 1]);
    original.push_str("}}");
    let content = fit(
        &result,
        &OperationResultMessageReferences::default(),
        original,
    )
    .unwrap();
    assert!(content.len() < 8_000, "{}", content.len());
    assert!(content.contains("[content omitted; continue from the provided cursor or artifact]"));
    assert!(content.contains("\"original_provider_bytes\":"));
}
