//! Bounded, source-shaped facts from the current Turn's durable tool journal.

mod semantic;
mod value;

use sha2::{Digest, Sha256};

use crate::btcc::{BtccError, ToolJournalRecord};
use crate::json::visit_raw_object;

const MAX_RECORD_BYTES: usize = 6_000;
const MAX_TOTAL_BYTES: usize = 20_000;

pub(super) fn render(records: Vec<ToolJournalRecord>) -> Result<String, BtccError> {
    let mut encoded = Vec::with_capacity(records.len().min(12));
    let mut total = 2usize; // Array brackets.
    for record in records.into_iter().take(12) {
        let separator = usize::from(!encoded.is_empty());
        let available = MAX_RECORD_BYTES.min(MAX_TOTAL_BYTES.saturating_sub(total + separator));
        if available == 0 {
            break;
        }
        if let Some(projected) = project_record(record, available)? {
            total += projected.len() + separator;
            encoded.push(projected);
        }
    }
    if encoded.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(
        "## Previously recorded tool calls for this turn\n\nRecords are newest first.\n\nUse these results as facts. Do not repeat a successful mutation unless the user request requires it.\n\nA call still marked started has unknown completion. Retry reads if useful, but inspect the target before any further mutation.\n\n[{}]",
        encoded.join(",")
    ))
}

fn project_record(
    record: ToolJournalRecord,
    available: usize,
) -> Result<Option<String>, BtccError> {
    let mut arguments = record.arguments;
    if let Some(object) = arguments.as_object_mut() {
        if record.tool_name == "write_file" || record.tool_name == "edit_file" {
            object.shift_remove("expected_sha256");
        }
        if record.tool_name == "write_file" {
            object.shift_remove("overwrite");
        }
    }
    let arguments_value = value::project(arguments, 0, "")?;
    let arguments = encode(&arguments_value)?;
    let facts = semantic::facts(record.result.as_ref(), record.error_code.as_deref())?;
    let preview = record
        .result
        .as_ref()
        .map(|body| {
            super::super::guided_tools::structured_tool_preview(&record.tool_name, body.as_str())
        })
        .transpose()?
        .map(|raw| omit_preview_controls(&raw))
        .transpose()?
        .filter(|raw| raw != "{}");

    let base = Base {
        name: &record.tool_name,
        status: &record.status,
        result_sha: record.result_sha256.as_deref(),
        facts: &facts,
    };
    let full = encode_record(&base, &arguments, preview.as_deref())?;
    if full.len() <= available {
        return Ok(Some(full));
    }
    let preview_digest = preview.as_deref().map(value::json_digest);
    let compacted = encode_record(&base, &arguments, preview_digest.as_deref())?;
    if compacted.len() <= available {
        return Ok(Some(compacted));
    }
    let omitted_arguments = value::preserve_arguments(&arguments_value, &arguments)?;
    let final_record = encode_record(&base, &omitted_arguments, preview_digest.as_deref())?;
    Ok((final_record.len() <= available).then_some(final_record))
}

struct Base<'a> {
    name: &'a str,
    status: &'a str,
    result_sha: Option<&'a str>,
    facts: &'a str,
}

fn encode_record(
    base: &Base<'_>,
    arguments: &str,
    preview: Option<&str>,
) -> Result<String, BtccError> {
    let mut output = String::from("{\"tool_name\":");
    write_string(base.name, &mut output)?;
    output.push_str(",\"status\":");
    write_string(base.status, &mut output)?;
    output.push_str(",\"arguments\":");
    output.push_str(arguments);
    if let Some(sha) = base.result_sha {
        output.push_str(",\"result_sha256\":");
        write_string(sha, &mut output)?;
    }
    if let Some(preview) = preview {
        output.push_str(",\"result_preview\":");
        output.push_str(preview);
    }
    if !base.facts.is_empty() {
        output.push(',');
        output.push_str(base.facts);
    }
    output.push('}');
    Ok(output)
}

fn omit_preview_controls(raw: &str) -> Result<String, BtccError> {
    let mut output = String::from("{");
    visit_raw_object(raw, |key, value| {
        let name: String = serde_json::from_str(key).map_err(crate::json::JsonError::from)?;
        if !matches!(
            name.as_str(),
            "tool_name"
                | "error"
                | "recoverable"
                | "next_action"
                | "effect_status"
                | "effect_receipt"
        ) {
            if output.len() > 1 {
                output.push(',');
            }
            output.push_str(key);
            output.push(':');
            output.push_str(value);
        }
        Ok(())
    })
    .map_err(json_error)?;
    output.push('}');
    Ok(output)
}

pub(super) fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(super) fn encode(value: &serde_json::Value) -> Result<String, BtccError> {
    crate::json::stringify(value).map_err(json_error)
}

pub(super) fn write_string(text: &str, output: &mut String) -> Result<(), BtccError> {
    crate::json::write_string(text, output).map_err(json_error)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
pub(super) fn json_error(error: crate::json::JsonError) -> BtccError {
    BtccError::relayed("guided_prompt_json_invalid", error.to_string())
}
