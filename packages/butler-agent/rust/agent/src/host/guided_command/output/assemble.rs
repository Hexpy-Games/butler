//! Source command result assembly after process, budgeting, and artifact publication.

use serde_json::Value;

use super::super::artifacts::Artifact;
use super::super::{evidence, structured_stdout, validation};
use crate::btcc::BtccError;
use crate::context::BudgetedToolOutput;
use crate::json::JsonDocument;
use crate::workspace::GuidedSummary;

#[derive(Clone, Copy)]
pub(super) struct Assembly<'a> {
    pub base: &'a JsonDocument,
    pub budget: &'a BudgetedToolOutput,
    pub summary: &'a GuidedSummary,
    pub artifacts: &'a [Artifact],
    pub requested: usize,
    pub declared: usize,
    pub publication_error: Option<&'a str>,
    pub registered: bool,
    pub effect: Option<&'a str>,
    pub structured: Option<&'a structured_stdout::Metadata>,
}

pub(super) fn assemble(input: Assembly<'_>) -> Result<JsonDocument, BtccError> {
    let Assembly {
        base,
        budget,
        summary,
        artifacts,
        requested,
        declared,
        publication_error,
        registered,
        effect,
        structured,
    } = input;
    let success = budget.exit_code == Some(0) && !budget.timed_out;
    let mut encoded = String::from("{\"ok\":");
    encoded.push_str(if success { "true" } else { "false" });
    append_field_string(&mut encoded, "command", &summary.command)?;
    append_field_string(&mut encoded, "cwd", &summary.cwd)?;
    for key in [
        "exit_code",
        "timed_out",
        "stdout",
        "stderr",
        "output_presentation",
    ] {
        if let Some(value) = base
            .field(key)
            .map_err(|_| error("command_result_encoding_failed"))?
        {
            append_raw(&mut encoded, key, value)?;
        }
    }
    if !registered {
        append_field_string(
            &mut encoded,
            "sandbox",
            if effect.is_some() {
                "full_access_contained"
            } else {
                "read_only_no_network"
            },
        )?;
    }
    if (success || registered) && requested > 0 {
        let unpublished = requested.saturating_sub(declared);
        let mut details = serde_json::json!({
            "ok": unpublished == 0 && publication_error.is_none(),
            "requested": requested,
            "published": declared,
            "unpublished": unpublished,
        });
        if unpublished > 0 || publication_error.is_some() {
            details["error"] = serde_json::json!({
                "code": publication_error.unwrap_or("declared_output_files_unavailable"),
                "message": "Some declared output files could not be published. Declare existing regular files inside the active workspace or Butler artifact directory."
            });
        }
        append_value(&mut encoded, "artifact_publication", &details)?;
    }
    if let Some(value) = base
        .field("butler_tool_artifact")
        .map_err(|_| error("command_result_encoding_failed"))?
    {
        append_raw(&mut encoded, "butler_tool_artifact", value)?;
    }
    if !artifacts.is_empty() {
        if registered {
            append_raw(&mut encoded, "durable_artifact_created", "true")?;
            append_value(
                &mut encoded,
                "verified_output_files",
                &serde_json::json!(&artifacts),
            )?;
            let labels: Vec<_> = artifacts
                .iter()
                .map(|artifact| artifact.path.as_str())
                .collect();
            let mut kinds = Vec::new();
            for artifact in artifacts {
                if !kinds.contains(&artifact.artifact_kind) {
                    kinds.push(artifact.artifact_kind);
                }
            }
            append_value(&mut encoded, "written_files", &serde_json::json!(labels))?;
            append_field_string(&mut encoded, "written_file", labels[0])?;
            append_value(&mut encoded, "artifact_labels", &serde_json::json!(labels))?;
            append_field_string(&mut encoded, "artifact_label", labels[0])?;
            append_value(&mut encoded, "artifact_kinds", &serde_json::json!(kinds))?;
            append_field_string(&mut encoded, "artifact_kind", kinds[0])?;
            if kinds
                .iter()
                .any(|kind| matches!(*kind, "csv_file" | "table_file"))
            {
                append_raw(&mut encoded, "data_table_created", "true")?;
            }
            if kinds.contains(&"chart_file") {
                append_raw(&mut encoded, "chart_rendered", "true")?;
            }
        } else {
            append_value(&mut encoded, "artifacts", &serde_json::json!(&artifacts))?;
            append_value(
                &mut encoded,
                "verified_output_files",
                &serde_json::json!(&artifacts),
            )?;
        }
    }
    if registered || !artifacts.is_empty() {
        append_value(
            &mut encoded,
            "evidence_receipts",
            &serde_json::json!(evidence::receipts(success, artifacts)),
        )?;
        let suppressed = budget
            .output_presentation
            .as_ref()
            .is_some_and(|p| p.suppressed);
        if registered {
            let receipts = validation::capability_receipts(
                budget.exit_code,
                budget.timed_out,
                suppressed,
                budget.butler_tool_artifact.is_some(),
                artifacts,
                structured.map_or(&[], |value| value.validations.as_slice()),
            )?;
            append_raw(&mut encoded, "evidence_capability_receipts", &receipts)?;
        } else {
            append_value(
                &mut encoded,
                "evidence_capability_receipts",
                &serde_json::json!(evidence::capability_receipts(
                    budget.exit_code,
                    budget.timed_out,
                    suppressed,
                    budget.butler_tool_artifact.is_some(),
                    artifacts
                )),
            )?;
        }
    }
    if let Some(effect) = effect {
        append_field_string(&mut encoded, "effect", effect)?;
        append_raw(&mut encoded, "command_outcome_observed", "true")?;
    }
    encoded.push('}');
    JsonDocument::from_encoded(encoded).map_err(|_| error("command_result_encoding_failed"))
}

fn append_raw(out: &mut String, key: &str, value: &str) -> Result<(), BtccError> {
    out.push(',');
    crate::json::write_string(key, out).map_err(|_| error("command_result_encoding_failed"))?;
    out.push(':');
    out.push_str(value);
    Ok(())
}

fn append_field_string(out: &mut String, key: &str, value: &str) -> Result<(), BtccError> {
    out.push(',');
    crate::json::write_string(key, out).map_err(|_| error("command_result_encoding_failed"))?;
    out.push(':');
    crate::json::write_string(value, out).map_err(|_| error("command_result_encoding_failed"))
}

fn append_value(out: &mut String, key: &str, value: &Value) -> Result<(), BtccError> {
    let encoded =
        crate::json::stringify(value).map_err(|_| error("command_result_encoding_failed"))?;
    append_raw(out, key, &encoded)
}

fn error(code: &'static str) -> BtccError {
    BtccError::relayed(code, code)
}
