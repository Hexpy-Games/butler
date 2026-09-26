use super::call::{error, json_error};
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
        if crate::segmentation::grapheme_segments(&candidate).count() > 480 {
            continue;
        }
        let mut next = evidence.clone();
        for quote in &claim.evidence {
            if !next.contains(quote) {
                next.push(quote.clone())
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

pub(super) fn aggregate_usage(stages: &[Value]) -> Value {
    let called = stages
        .iter()
        .filter(|stage| stage.get("reused") == Some(&Value::Bool(false)))
        .collect::<Vec<_>>();
    if called
        .iter()
        .any(|stage| stage.pointer("/provider/usage").is_none_or(Value::is_null))
    {
        return Value::Null;
    }
    let sum = |key: &str| {
        called
            .iter()
            .filter_map(|stage| {
                stage
                    .pointer(&format!("/provider/usage/{key}"))
                    .and_then(Value::as_f64)
            })
            .sum::<f64>()
    };
    json!({"prompt_tokens":sum("prompt_tokens"),"cached_tokens":sum("cached_tokens"),
        "output_tokens":sum("output_tokens"),"total_tokens":sum("total_tokens")})
}

pub(super) fn bounded_evidence_schema(
    schema: &Map<String, Value>,
    passages: usize,
) -> Map<String, Value> {
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
        return Err(error("memory_extract_invalid_output"));
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
        return Err(error("memory_extract_invalid_output"));
    }
    Ok(())
}
