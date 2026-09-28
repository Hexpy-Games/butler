//! Checks and finishing of a run's output: the size and coverage bounds of
//! [`ExtractOutput`], its bounded summary, and the meaning schema narrowed
//! to the window's passage ids.

use super::call::{error, json_error};
use crate::cognition::CognitionCode;
use crate::cognition::{
    CognitionResult,
    extraction::{ExtractInput, ExtractOutput, ExtractSummary},
};
use serde_json::{Map, Value, json};

pub(super) fn summarize(output: &mut ExtractOutput) {
    let mut lines = Vec::new();
    let mut evidence = Vec::new();
    for claim in &output.claims {
        let line = format!(
            "[model_interpretation/{}/{}] {}",
            claim.basis, claim.speech_act, claim.statement
        );
        let candidate = lines
            .iter()
            .chain(std::iter::once(&line))
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        if butler_core::segmentation::grapheme_segments(&candidate).count() > 480 {
            continue;
        }
        let mut next = evidence.clone();
        for quote in &claim.evidence {
            if !next.contains(quote) {
                next.push(quote.clone());
            }
        }
        if next.len() > 4 {
            continue;
        }
        lines.push(line);
        evidence = next;
    }
    output.summary = if lines.is_empty() {
        None
    } else {
        Some(ExtractSummary {
            text: lines.join("\n"),
            evidence,
        })
    };
}

/// The meaning schema with every `evidence` item bounded to `0..passages`.
/// Passthrough: `schema` is a JSON Schema document for the provider.
pub(super) fn bounded_evidence_schema(
    // Passthrough: JSON Schema for the provider.
    schema: &Map<String, Value>,
    passages: usize,
) -> Map<String, Value> {
    // Passthrough: walks the provider's JSON Schema document.
    fn visit_object(object: &mut Map<String, Value>, max: usize) {
        if let Some(evidence) = object
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .and_then(|properties| properties.get_mut("evidence"))
            .and_then(Value::as_object_mut)
        {
            evidence.insert(
                "items".into(),
                json!({"type":"integer","minimum":0,"maximum":max.saturating_sub(1)}),
            );
        }
        for child in object.values_mut() {
            visit(child, max);
        }
    }
    // Passthrough: walks the provider's JSON Schema document.
    fn visit(value: &mut Value, max: usize) {
        match value {
            Value::Object(object) => visit_object(object, max),
            Value::Array(items) => {
                for child in items {
                    visit(child, max);
                }
            }
            _ => {}
        }
    }
    let mut bounded = schema.clone();
    visit_object(&mut bounded, passages);
    bounded
}
pub(super) fn validate_output(output: &ExtractOutput, input: &ExtractInput) -> CognitionResult<()> {
    if !matches!(
        output.schema.as_str(),
        "butler.memory-extract-output.v2" | "butler.memory-extract-output.v3"
    ) || output.window_ref != input.window_ref
        || output.nodes.len() > 32
        || output.claims.len() > 48
        || output.relations.len() > 64
        || output.corrections.len() > 16
        || serde_json::to_vec(output).map_err(json_error)?.len() > 65536
    {
        return Err(error(CognitionCode::MemoryExtractInvalidOutput));
    }
    let expected = input
        .source_units
        .iter()
        .map(|x| x.ref_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let covered = output
        .covered_unit_refs
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    if output.disposition == "processed" && expected != covered {
        return Err(error(CognitionCode::MemoryExtractInvalidOutput));
    }
    Ok(())
}
