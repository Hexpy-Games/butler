use super::*;
#[test]
fn structured_previews_drop_private_fields_and_bound_artifact_pages() {
    let cases = [
        (
            "run_command",
            r#"{"ok":true,"output":{"model_visible_content":"done","exit_code":0,"evidence_receipts":["private"],"foo":1}}"#,
            r#"{"tool_name":"run_command","model_visible_content":"done","exit_code":0,"foo":1}"#,
        ),
        (
            "grep_files",
            r#"{"result":{"matches":[{"path":"a","text":"x"},{"path":"a"},{"path":"b"}],"pattern":"x","metrics":{"duration":1},"evidence_receipts":["private"]}}"#,
            r#"{"tool_name":"grep_files","matches":[{"path":"a","text":"x"},{"path":"a"},{"path":"b"}],"pattern":"x","match_count":3,"candidate_paths":["a","b"]}"#,
        ),
        (
            "read_conversation_context",
            r#"{"output":{"messages":[1],"summaries":[],"runtime_session_id":"private"}}"#,
            r#"{"tool_name":"read_conversation_context","messages":[1],"summaries":[]}"#,
        ),
        (
            "read_tool_output_artifact",
            r#"{"output":{"ok":true,"artifact":{"id":" a ","path":" /x ","tool_name":"run_command","command":"echo hi","raw_tokens":3},"stdout":{"text":"hello","start_line":0,"next_offset_chars":null,"truncated_by_tokens":false},"stderr":{"text":"","start_char":0},"error":"  nope  "}}"#,
            r#"{"tool_name":"read_tool_output_artifact","ok":true,"artifact":{"id":"a","path":"/x","tool_name":"run_command","command":"echo hi","raw_tokens":3},"stdout":{"text":"hello","start_line":0,"next_offset_chars":null,"truncated_by_tokens":false},"stderr":{"text":"","start_char":0},"error":"nope"}"#,
        ),
        (
            "read_tool_evidence_artifact",
            r#"{"result":{"ok":true,"artifact":{"id":"ev","path":" /evidence ","tool_name":"grep_files","command":"  command ","raw_tokens":2},"text":{"text":"line","start_char":3,"next_offset_chars":7,"returned_lines":1,"total_chars":10,"search":{"query":" q ","found":true,"match_char":null}},"error":"  no  "}}"#,
            r#"{"tool_name":"read_tool_evidence_artifact","ok":true,"artifact":{"id":"ev","path":"/evidence","tool_name":"grep_files","command":"command","raw_tokens":2},"text":{"text":"line","start_char":3,"next_offset_chars":7,"returned_lines":1,"total_chars":10,"search":{"query":"q","found":true,"match_char":null}},"error":"no"}"#,
        ),
        (
            "list_conversation_sessions",
            r#"{"sessions":[1]}"#,
            r#"{"tool_name":"list_conversation_sessions","sessions":[1]}"#,
        ),
        (
            "read_conversation_session",
            r#"{"messages":[1]}"#,
            r#"{"tool_name":"read_conversation_session","messages":[1]}"#,
        ),
    ];
    for (name, raw, expected) in cases {
        assert_eq!(structured_raw(name, raw).unwrap(), expected, "{name}");
    }
    let result = ToolResult {
        tool_call_id: "command-1".into(),
        name: "run_command".into(),
        ok: true,
        error: None,
        output: Some(
            JsonDocument::from_encoded(
                r#"{"model_visible_content":"done","exit_code":0,"evidence_receipts":["private"]}"#
                    .into(),
            )
            .unwrap(),
        ),
    };
    let original = format!(
        "{{\"ok\":true,\"output\":{}}}",
        result.output.as_ref().unwrap().as_str()
    );
    assert_eq!(
        fit(
            &result,
            &OperationResultMessageReferences::default(),
            original
        )
        .unwrap(),
        r#"{"ok":true,"output":{"tool_name":"run_command","model_visible_content":"done","exit_code":0}}"#,
    );
    let page = serde_json::json!({
        "ok": true,
        "output": {
            "tool_name": "read_tool_output_artifact",
            "stdout": {"text": "A😀\nB".repeat(20), "start_char": 5,
                "total_chars": 100, "next_offset_chars": null,
                "returned_lines": 0, "truncated_by_tokens": false},
            "stderr": {"text": "", "start_char": 0}
        }
    });
    let page = crate::json::stringify(&page).unwrap();
    assert_eq!(
        artifact::fit(&page, 300).unwrap(),
        r#"{"ok":true,"output":{"tool_name":"read_tool_output_artifact","stdout":{"text":"A😀\nBA😀\nBA","start_char":5,"total_chars":100,"next_offset_chars":16,"returned_lines":3,"truncated_by_tokens":true},"stderr":{"text":"","start_char":0}},"model_preview":{"truncated":true,"completeness":"partial"}}"#,
    );
}

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
    let encoded = crate::json::stringify(&output).unwrap();
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
