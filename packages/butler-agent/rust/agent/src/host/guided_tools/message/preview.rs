//! Source provider projection over immutable result JSON.

mod artifact;
mod bound;
mod exact;
mod retained;
mod work;

use crate::btcc::{BtccError, OperationResultMessageReferences, ToolResult};
#[cfg(test)]
use crate::json::JsonDocument;
use crate::json::visit_raw_object;

const MAX_BYTES: usize = 50 * 1024;

/// The same tool-specific structured view used for provider results, before
/// either caller applies its own byte budget.
pub(in crate::host) fn structured_raw(name: &str, raw: &str) -> Result<String, BtccError> {
    let candidate = tool_payload(raw, keys(name), 0)?.unwrap_or(raw);
    if work::supports(name) && candidate.trim().starts_with('{') {
        work::project_raw(name, candidate)
    } else if name == "read_operation_results" && field(candidate, "data")?.is_some_and(string_raw)
    {
        exact::project_raw(candidate)
    } else if matches!(
        name,
        "read_tool_output_artifact" | "read_tool_evidence_artifact"
    ) && candidate.trim_start().starts_with('{')
    {
        artifact::project(name, candidate)
    } else if matches!(
        name,
        "run_command" | "grep_files" | "read_conversation_context"
    ) && candidate.trim_start().starts_with('{')
    {
        retained::project(name, candidate)
    } else {
        generic_output(name, candidate)
    }
}

pub(super) fn fit(
    result: &ToolResult,
    references: &OperationResultMessageReferences,
    original: String,
) -> Result<String, BtccError> {
    let specialized = work::supports(&result.name)
        || matches!(
            result.name.as_str(),
            "read_operation_results"
                | "run_command"
                | "grep_files"
                | "read_conversation_context"
                | "read_tool_output_artifact"
                | "read_tool_evidence_artifact"
        );
    let output = result.output.as_ref();
    let partial_exact = result.name != "read_operation_results"
        && references.exact_read.is_some()
        && output.is_some_and(|value| bound::signals_partial(value.as_str()));
    let nested_file = result.name == "read_file"
        && output.is_some_and(|value| {
            field(value.as_str(), "files").ok().flatten().is_none()
                && tool_payload(value.as_str(), &["files"], 0)
                    .ok()
                    .flatten()
                    .is_some_and(|nested| nested.as_ptr() != value.as_str().as_ptr())
        });
    if !specialized && !nested_file && !partial_exact && original.len() <= MAX_BYTES {
        return Ok(original);
    }
    let mut projected = String::from("{\"ok\":");
    projected.push_str(if result.ok { "true" } else { "false" });
    if !result.ok
        && let Some(error) = &result.error
    {
        projected.push_str(",\"error\":");
        projected.push_str(
            &crate::json::stringify(&serde_json::to_value(error).map_err(|_| failure())?)
                .map_err(|_| failure())?,
        );
    }
    if let Some(output) = output {
        projected.push_str(",\"output\":");
        projected.push_str(&structured_raw(&result.name, output.as_str())?);
    }
    let exact_read = if result.name == "read_operation_results" {
        None
    } else {
        references
            .exact_read
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|_| failure())?
    };
    let exact_read = exact_read.as_ref();
    if partial_exact {
        let payload = payload(result)?;
        projected.push_str(",\"model_preview\":");
        projected.push_str(
            &crate::json::stringify(&bound::metadata(payload.len(), exact_read))
                .map_err(|_| failure())?,
        );
    }
    projected.push('}');
    let encoded = if result.name == "read_operation_results" {
        exact::fit(&projected, MAX_BYTES)?
    } else if matches!(
        result.name.as_str(),
        "read_tool_output_artifact" | "read_tool_evidence_artifact"
    ) {
        artifact::fit(&projected, MAX_BYTES)?
    } else {
        bound::fit(&projected, &result.name, exact_read, MAX_BYTES)?
    };
    if encoded == original && encoded.len() <= MAX_BYTES {
        Ok(original)
    } else {
        Ok(encoded)
    }
}

fn keys(name: &str) -> &'static [&'static str] {
    match name {
        "read_file" => &["files"],
        "grep_files" => &["matches", "pattern"],
        "read_conversation_context" => &["messages", "summaries"],
        "run_command" => &["model_visible_content", "exit_code"],
        "read_operation_results" => &["encoding", "data", "offset"],
        "read_tool_output_artifact" => &["stdout", "stderr"],
        "read_tool_evidence_artifact" => &["text", "artifact"],
        name if work::supports(name) => &["work", "error"],
        _ => &[],
    }
}

fn generic_output(name: &str, candidate: &str) -> Result<String, BtccError> {
    let mut output = String::from("{\"tool_name\":");
    crate::json::write_string(name, &mut output).map_err(|_| failure())?;
    let candidate = candidate.trim();
    if candidate.starts_with('{') {
        if !candidate[1..candidate.len() - 1].trim().is_empty() {
            output.push(',');
            output.push_str(&candidate[1..candidate.len() - 1]);
        }
    } else {
        output.push_str(if string_raw(candidate) {
            ",\"text\":"
        } else {
            ",\"value\":"
        });
        output.push_str(candidate);
    }
    output.push('}');
    Ok(output)
}

fn payload(result: &ToolResult) -> Result<String, BtccError> {
    let mut body = String::from("{\"ok\":");
    body.push_str(if result.ok { "true" } else { "false" });
    if !result.ok
        && let Some(error) = &result.error
    {
        body.push_str(",\"error\":");
        body.push_str(
            &crate::json::stringify(&serde_json::to_value(error).map_err(|_| failure())?)
                .map_err(|_| failure())?,
        );
    }
    if let Some(output) = &result.output {
        body.push_str(",\"output\":");
        body.push_str(output.as_str());
    }
    body.push('}');
    Ok(body)
}

fn tool_payload<'a>(
    raw: &'a str,
    keys: &[&str],
    depth: usize,
) -> Result<Option<&'a str>, BtccError> {
    if !raw.trim().starts_with('{') {
        return Ok(None);
    }
    if keys.is_empty()
        || keys
            .iter()
            .any(|key| field(raw, key).ok().flatten().is_some())
        || depth >= 3
    {
        return Ok(Some(raw));
    }
    for key in ["result", "output"] {
        if let Some(nested) = field(raw, key)?
            && let Some(candidate) = tool_payload(nested, keys, depth + 1)?
            && keys
                .iter()
                .any(|key| field(candidate, key).ok().flatten().is_some())
        {
            return Ok(Some(candidate));
        }
    }
    Ok(Some(raw))
}

pub(super) fn field<'a>(raw: &'a str, name: &str) -> Result<Option<&'a str>, BtccError> {
    if !raw.trim().starts_with('{') {
        return Ok(None);
    }
    let mut selected = None;
    visit_raw_object(raw, |key, value| {
        if serde_json::from_str::<String>(key).ok().as_deref() == Some(name) {
            selected = Some(value);
        }
        Ok(())
    })
    .map_err(|_| failure())?;
    Ok(selected)
}

pub(super) fn append_field(output: &mut String, name: &str, raw: &str) -> Result<(), BtccError> {
    output.push(',');
    crate::json::write_string(name, output).map_err(|_| failure())?;
    output.push(':');
    output.push_str(raw);
    Ok(())
}
fn string_raw(raw: &str) -> bool {
    raw.trim_start().starts_with('"')
}
fn failure() -> BtccError {
    BtccError::new(
        "guided_tool_provider_serialization_failed",
        "Provider result JSON unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_structured_previews_match_source_bun_oracle() {
        // JSON.stringify(structuredToolResultModelPreview(...)) on the unchanged TS source.
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
                    r#"{"model_visible_content":"done","exit_code":0,"evidence_receipts":["private"]}"#.into(),
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
    fn large_memory_result_matches_bun_provider_preview_boundary() {
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
        assert_eq!(content.len(), 4_972);
        assert!(content.contains("\"original_provider_bytes\":62443"));
        assert!(content.contains(&format!(
            "{}\\ud83d\\n[content omitted; continue from the provided cursor or artifact]\\n{}",
            "A".repeat(2_366),
            "B".repeat(2_367),
        )));
    }
}
