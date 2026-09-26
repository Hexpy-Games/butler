//! Exact UTF-16 text is appended as JSON literals, never carried through Value.

use super::*;
use crate::context::tool_artifact_slice::{ToolArtifactSearch, ToolArtifactTextSlice};

impl BudgetedToolOutput {
    pub(crate) fn to_json_document(&self) -> ContextResult<String> {
        let mut output = String::new();
        output.push_str("{\"stdout\":");
        self.stdout.append_json_literal(&mut output)?;
        output.push_str(",\"stderr\":");
        self.stderr.append_json_literal(&mut output)?;
        output.push_str(",\"exit_code\":");
        append_optional_i32(&mut output, self.exit_code);
        output.push_str(",\"timed_out\":");
        output.push_str(if self.timed_out { "true" } else { "false" });
        if let Some(presentation) = &self.output_presentation {
            output.push_str(",\"output_presentation\":{");
            output.push_str("\"mode\":");
            append_string(&mut output, presentation.mode)?;
            output.push_str(",\"requested_max_tokens\":");
            append_optional_number(&mut output, presentation.requested_max_tokens)?;
            output.push_str(",\"applied_max_tokens\":");
            output.push_str(&presentation.applied_max_tokens.to_string());
            output.push_str(",\"suppressed\":");
            output.push_str(if presentation.suppressed {
                "true"
            } else {
                "false"
            });
            output.push_str(",\"truncated\":");
            output.push_str(if presentation.truncated {
                "true"
            } else {
                "false"
            });
            output.push('}');
        }
        if let Some(artifact) = &self.butler_tool_artifact {
            output.push_str(",\"butler_tool_artifact\":{");
            output.push_str("\"id\":");
            append_string(&mut output, &artifact.id)?;
            output.push_str(",\"path\":");
            append_path(&mut output, &artifact.path)?;
            output.push_str(",\"raw_tokens\":");
            output.push_str(&(artifact.raw_tokens as u64).to_string());
            output.push_str(",\"compact_tokens\":");
            output.push_str(&(artifact.compact_tokens as u64).to_string());
            output.push_str(",\"created_at\":");
            append_string(&mut output, &artifact.created_at)?;
            if let Some(command) = &artifact.command {
                output.push_str(",\"command\":");
                append_string(&mut output, command)?;
            }
            output.push('}');
        }
        output.push('}');
        Ok(output)
    }
}

impl FocusedToolOutputArtifactRead {
    pub(crate) fn to_json_document(&self) -> ContextResult<String> {
        let mut output = String::new();
        if !self.ok {
            output.push_str("{\"ok\":false,\"error\":");
            append_string(&mut output, self.error.unwrap_or("artifact_unreadable"))?;
            output.push_str(",\"rawTextStored\":false}");
            return Ok(output);
        }
        output.push_str("{\"schema_version\":\"butler.tool-evidence-rehydration.v1\",\"terminal_evidence_observation\":true,\"ok\":true,\"rawTextStored\":false");
        if let Some(artifact) = &self.artifact {
            output.push_str(",\"artifact\":{");
            output.push_str("\"id\":");
            append_string(&mut output, &artifact.id)?;
            output.push_str(",\"path\":");
            append_path(&mut output, &artifact.path)?;
            output.push_str(",\"created_at\":");
            append_optional_string(&mut output, artifact.created_at.as_deref())?;
            output.push_str(",\"command\":");
            append_optional_string(&mut output, artifact.command.as_deref())?;
            output.push_str(",\"cwd\":");
            append_optional_string(&mut output, artifact.cwd.as_deref())?;
            output.push_str(",\"raw_tokens\":");
            append_optional_number(&mut output, artifact.raw_tokens)?;
            output.push('}');
        }
        output.push_str(",\"limits\":{");
        output.push_str("\"requested_max_tokens\":");
        append_optional_number(&mut output, self.requested_max_tokens)?;
        output.push_str(",\"applied_max_tokens\":");
        output.push_str(&self.applied_max_tokens.unwrap_or(1_200).to_string());
        output.push_str(",\"requested_limit_lines\":");
        append_optional_number(&mut output, self.requested_limit_lines)?;
        output.push_str(",\"applied_limit_lines\":");
        output.push_str(&self.applied_limit_lines.unwrap_or(80).to_string());
        output.push('}');
        if let Some(slice) = &self.stdout {
            output.push_str(",\"stdout\":");
            append_slice(&mut output, slice)?;
        }
        if let Some(slice) = &self.stderr {
            output.push_str(",\"stderr\":");
            append_slice(&mut output, slice)?;
        }
        output.push('}');
        Ok(output)
    }
}

pub(super) fn append_slice(
    output: &mut String,
    slice: &ToolArtifactTextSlice,
) -> ContextResult<()> {
    output.push_str("{\"text\":");
    slice.text.append_json_literal(output)?;
    output.push_str(",\"start_line\":");
    output.push_str(&slice.start_line.to_string());
    output.push_str(",\"returned_lines\":");
    output.push_str(&slice.returned_lines.to_string());
    output.push_str(",\"total_lines\":");
    output.push_str(&slice.total_lines.to_string());
    output.push_str(",\"estimated_tokens\":");
    output.push_str(&(slice.estimated_tokens as u64).to_string());
    output.push_str(",\"truncated_by_lines\":");
    output.push_str(if slice.truncated_by_lines {
        "true"
    } else {
        "false"
    });
    output.push_str(",\"truncated_by_tokens\":");
    output.push_str(if slice.truncated_by_tokens {
        "true"
    } else {
        "false"
    });
    output.push_str(",\"start_char\":");
    output.push_str(&slice.start_char.to_string());
    output.push_str(",\"next_offset_chars\":");
    match slice.next_offset_chars {
        Some(offset) => output.push_str(&offset.to_string()),
        None => output.push_str("null"),
    }
    output.push_str(",\"total_chars\":");
    output.push_str(&slice.total_chars.to_string());
    output.push_str(",\"applied_max_tokens\":");
    output.push_str(&slice.applied_max_tokens.to_string());
    if let Some(search) = &slice.search {
        output.push_str(",\"search\":");
        append_search(output, search)?;
    }
    output.push('}');
    Ok(())
}

fn append_search(output: &mut String, search: &ToolArtifactSearch) -> ContextResult<()> {
    output.push_str("{\"query\":");
    append_string(output, &search.query)?;
    output.push_str(",\"found\":");
    output.push_str(if search.found { "true" } else { "false" });
    output.push_str(",\"match_char\":");
    match search.match_char {
        Some(offset) => output.push_str(&offset.to_string()),
        None => output.push_str("null"),
    }
    output.push('}');
    Ok(())
}

fn append_optional_i32(output: &mut String, value: Option<i32>) {
    match value {
        Some(value) => output.push_str(&value.to_string()),
        None => output.push_str("null"),
    }
}

pub(super) fn append_optional_number(output: &mut String, value: Option<f64>) -> ContextResult<()> {
    match value {
        Some(value) if value.is_finite() => {
            let number = serde_json::Number::from_f64(value)
                .ok_or_else(|| ContextError::new("tool_output_json_error", "Invalid number"))?;
            output.push_str(
                &crate::json::stringify(&serde_json::Value::Number(number)).map_err(|error| {
                    ContextError::new("tool_output_json_error", error.to_string())
                })?,
            );
        }
        _ => output.push_str("null"),
    }
    Ok(())
}

pub(super) fn append_optional_string(
    output: &mut String,
    value: Option<&str>,
) -> ContextResult<()> {
    match value {
        Some(value) => append_string(output, value),
        None => {
            output.push_str("null");
            Ok(())
        }
    }
}

pub(super) fn append_path(output: &mut String, path: &std::path::Path) -> ContextResult<()> {
    let value = path.to_str().ok_or_else(|| {
        ContextError::new("tool_output_path_encoding", "Artifact path is not UTF-8")
    })?;
    append_string(output, value)
}

pub(super) fn append_string(output: &mut String, value: &str) -> ContextResult<()> {
    crate::json::write_string(value, output)
        .map_err(|error| ContextError::new("tool_output_json_error", error.to_string()))
}
