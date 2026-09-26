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
mod tests;
