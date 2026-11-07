//! `progress-row-projection-fields.ts`: the fields a turn event's payload gives a progress row.
#![allow(
    clippy::cast_possible_truncation,
    reason = "the counts are small non-negative integers"
)]
use serde_json::{Map, Value, json};

use super::public_text::sanitize_public_text;

const PUBLIC_DECISION_SOURCES: [&str; 3] =
    ["assistant-authored", "model-authored", "principal-authored"];
const CONTENT_KEYS: [&str; 13] = [
    "toolTitle",
    "checkingPrevious",
    "checkingRequest",
    "toolWorking",
    "checkingInformation",
    "commandExecuting",
    "conceptionTitle",
    "planningNext",
    "reportTitle",
    "conceptionSummary",
    "workInProgress",
    "toolsSummary",
    "workerStatus",
];
const PROGRESS_KINDS: [&str; 11] = [
    "searched",
    "read",
    "ran_command",
    "edited",
    "dispatch",
    "used_tool",
    "context",
    "model",
    "message",
    "turn",
    "system",
];

pub(super) type Payload = Map<String, Value>;

pub(super) fn safe_text(value: Option<&Value>, fallback: &str) -> String {
    sanitize_public_text(value, fallback)
}

pub(super) fn optional_text(value: Option<&Value>) -> Option<String> {
    Some(safe_text(value, "")).filter(|text| !text.is_empty())
}

/// JavaScript's `Number(value)` for the JSON values a payload field can hold.
pub(super) fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if text.trim().is_empty() => Some(0.),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        Value::Null => Some(0.),
        _ => None,
    }
}

/// `optionalNonNegativeInteger`.
pub(super) fn optional_non_negative_integer(value: Option<&Value>) -> Option<i64> {
    let number = to_number(value?)?;
    (number.is_finite() && number >= 0.).then(|| number.floor() as i64)
}

pub(super) fn text_list(value: Option<&Value>, limit: usize) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| optional_text(Some(item)))
        .take(limit)
        .collect()
}

pub(super) fn first<'a>(payload: &'a Payload, keys: &[&str]) -> Option<&'a Value> {
    // `a ?? b`: the first key whose value is neither null nor missing.
    keys.iter()
        .find_map(|key| payload.get(*key).filter(|value| !value.is_null()))
}

pub(super) fn set(fields: &mut Payload, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        fields.insert(key.to_string(), value.into());
    }
}

/// `workDecisionFields`' contract fields (`contractFields`).
pub(super) fn contract_fields(payload: &Payload) -> Payload {
    let mut fields = Payload::new();
    set(
        &mut fields,
        "work_contract_id",
        optional_text(payload.get("contractId")),
    );
    set(
        &mut fields,
        "work_stream_id",
        optional_text(payload.get("workstreamId")),
    );
    set(
        &mut fields,
        "semantic_block_id",
        optional_text(payload.get("semanticBlockId")),
    );
    set(
        &mut fields,
        "activity_stage",
        optional_text(payload.get("activityStage")),
    );
    fields
}

/// `workDecisionFields`.
pub(super) fn work_decision_fields(payload: &Payload) -> Payload {
    let mut fields = contract_fields(payload);
    let source = optional_text(first(payload, &["decisionSource", "source"]));
    let summary = optional_text(first(payload, &["decisionSummary", "summary"]));
    let (Some(source), Some(summary)) = (source, summary) else {
        return fields;
    };
    if !PUBLIC_DECISION_SOURCES.contains(&source.as_str()) {
        return fields;
    }
    set(
        &mut fields,
        "work_decision_id",
        optional_text(payload.get("decisionId")),
    );
    set(
        &mut fields,
        "work_decision_title",
        optional_text(first(payload, &["decisionTitle", "blockTitle"])),
    );
    fields.insert("work_decision_summary".into(), summary.into());
    set(
        &mut fields,
        "work_decision_rationale",
        optional_text(first(payload, &["decisionRationale", "rationale"])),
    );
    set(
        &mut fields,
        "work_decision_next_step",
        optional_text(first(payload, &["decisionNextStep", "nextStep"])),
    );
    fields.insert("work_decision_source".into(), source.into());
    let refs = text_list(first(payload, &["decisionEvidenceRefs", "evidenceRefs"]), 6);
    if !refs.is_empty() {
        fields.insert("work_decision_evidence_refs".into(), json!(refs));
    }
    fields
}

/// `standaloneDecisionFields`.
pub(super) fn standalone_decision_fields(payload: &Payload) -> Payload {
    let source = optional_text(payload.get("source"));
    let Some(source) = source.filter(|s| PUBLIC_DECISION_SOURCES.contains(&s.as_str())) else {
        return Payload::new();
    };
    let mut fields = contract_fields(payload);
    set(
        &mut fields,
        "public_decision_role",
        optional_text(payload.get("role")),
    );
    set(
        &mut fields,
        "public_decision_summary",
        optional_text(payload.get("summary")),
    );
    set(
        &mut fields,
        "public_decision_rationale",
        optional_text(payload.get("rationale")),
    );
    set(
        &mut fields,
        "public_decision_next_step",
        optional_text(payload.get("nextStep")),
    );
    fields.insert("public_decision_source".into(), source.into());
    set(
        &mut fields,
        "public_decision_model_call_id",
        optional_text(payload.get("modelCallId")),
    );
    set(
        &mut fields,
        "public_decision_latency_ms",
        optional_non_negative_integer(payload.get("latencyMs")),
    );
    let refs = text_list(payload.get("evidenceRefs"), 6);
    if !refs.is_empty() {
        fields.insert("public_decision_evidence_refs".into(), json!(refs));
    }
    fields
}

pub(super) fn work_block_phase(kind: &str) -> Option<&'static str> {
    match kind {
        "work.block.started" => Some("started"),
        "work.block.updated" => Some("updated"),
        "work.block.completed" => Some("completed"),
        _ => None,
    }
}

pub(super) fn completed_block_state(payload: &Payload) -> &'static str {
    match optional_text(payload.get("status")).as_deref() {
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        _ => "delivered",
    }
}

/// `blockSequence`: the direct number, else the `:block:N` suffix of the semantic block id.
pub(super) fn block_sequence(payload: &Payload) -> Option<i64> {
    if let Some(direct) = optional_non_negative_integer(payload.get("blockSequence")) {
        return Some(direct);
    }
    let id = optional_text(payload.get("semanticBlockId"))?;
    let (_, suffix) = id.rsplit_once(":block:")?;
    (!suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
        .then(|| suffix.parse().ok())
        .flatten()
}

pub(super) fn progress_kind(value: Option<&Value>) -> String {
    let kind = safe_text(value, "used_tool");
    if PROGRESS_KINDS.contains(&kind.as_str()) {
        kind
    } else {
        "used_tool".to_string()
    }
}

/// `detailRows`.
pub(super) fn detail_rows(value: Option<&Value>) -> Option<Value> {
    let Some(Value::Array(items)) = value else {
        return None;
    };
    let rows: Vec<Value> = items
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .take(8)
        .map(|(index, row)| {
            let mut out = Payload::new();
            out.insert(
                "id".into(),
                safe_text(row.get("id"), &format!("detail-{}", index + 1)).into(),
            );
            set(&mut out, "kind", optional_text(row.get("kind")));
            out.insert(
                "safe_label".into(),
                safe_text(row.get("safe_label"), "Detail").into(),
            );
            set(&mut out, "safe_value", optional_text(row.get("safe_value")));
            set(&mut out, "state", optional_text(row.get("state")));
            Value::Object(out)
        })
        .collect();
    (!rows.is_empty()).then_some(Value::Array(rows))
}

pub(super) fn clipped(value: &Value, limit: usize) -> Value {
    Value::String(
        value
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(limit)
            .collect(),
    )
}

/// `readInterfaceContent`: only the public template contract.
pub(super) fn read_interface_content(value: Option<&Value>) -> Option<Value> {
    let Some(Value::Object(content)) = value else {
        return None;
    };
    let mut result = Payload::new();
    for field in ["title", "summary", "nextStep"] {
        let Some(Value::Object(reference)) = content.get(field) else {
            continue;
        };
        let Some(key) = reference.get("key").and_then(Value::as_str) else {
            continue;
        };
        if !CONTENT_KEYS.contains(&key) {
            continue;
        }
        let mut parameters = Payload::new();
        if let Some(Value::Object(input)) = reference.get("parameters") {
            for name in ["toolName", "target", "text", "phase"] {
                if let Some(text @ Value::String(_)) = input.get(name) {
                    parameters.insert(name.to_string(), clipped(text, 600));
                }
            }
            if let Some(Value::Array(tools)) = input.get("tools") {
                let tools: Vec<Value> = tools
                    .iter()
                    .take(20)
                    .filter_map(|tool| {
                        let tool = tool.as_object()?;
                        let mut out = Payload::new();
                        let name = tool.get("name").filter(|name| name.is_string())?;
                        out.insert("name".into(), clipped(name, 120));
                        if let Some(target @ Value::String(_)) = tool.get("target") {
                            out.insert("target".into(), clipped(target, 160));
                        }
                        Some(Value::Object(out))
                    })
                    .collect();
                parameters.insert("tools".into(), Value::Array(tools));
            }
        }
        result.insert(
            field.to_string(),
            json!({ "key": key, "parameters": Value::Object(parameters) }),
        );
    }
    (!result.is_empty()).then_some(Value::Object(result))
}

/// `progressLabelParameters`.
pub(super) fn label_parameters(value: Option<&Value>) -> Option<Value> {
    let Value::Object(map) = value? else {
        return None;
    };
    let integer = |key: &str| {
        map.get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.fract() == 0.)
            .map(|n| n as i64)
    };
    Some(json!({ "attempt": integer("attempt")?, "maxAttempts": integer("maxAttempts")? }))
}
