//! Source-compatible public progress rows projected from validated runtime events.

use serde_json::{Map, Value, json};

use crate::gateway::application::service;

pub(super) fn row_from_runtime_event(
    kind: &str,
    payload: &Map<String, Value>,
    id: &str,
    now: &str,
    sequence: Option<u64>,
) -> Option<Map<String, Value>> {
    let mut row = base(id, now, sequence)?;
    match kind {
        "assistant.public_note" => {
            let note = safe(payload.get("note"), "Working");
            fields(
                &mut row,
                json!({"kind":"message","safe_label":note,
                "state":match optional(payload.get("recoveryStatus")).as_deref(){Some("cleared")=>"delivered",Some("interrupted")=>"failed",_=>"running"}}),
            );
            copy(
                payload,
                &mut row,
                "interfaceLabelKey",
                "interface_label_key",
            );
            copy_object(
                payload,
                &mut row,
                "interfaceLabelParameters",
                "interface_label_parameters",
            );
            copy_object(payload, &mut row, "interfaceContent", "interface_content");
            let block = optional(payload.get("workBlockId"));
            if let Some(value) = block.as_deref() {
                row.insert("work_block_id".into(), value.into());
            }
            let label = optional(payload.get("decisionTitle"))
                .or_else(|| optional(payload.get("workBlockLabel")))
                .or_else(|| block.map(|_| note));
            insert(&mut row, "work_block_label", label);
            insert(
                &mut row,
                "bridge_phase",
                optional(payload.get("bridgePhase")).or_else(|| {
                    (payload.get("operational").and_then(Value::as_bool) == Some(true))
                        .then(|| "operational_recovery".into())
                }),
            );
            work_decision(payload, &mut row);
        }
        "turn.first_progress" => fields(
            &mut row,
            json!({"kind":"turn","safe_label":safe(payload.get("note").or_else(||payload.get("safeLabel")),"Working"),"state":"thinking"}),
        ),
        "turn.acknowledged" => fields(
            &mut row,
            json!({"kind":"turn","safe_label":safe(payload.get("safeLabel"),"Request received. Preparing the work."),"state":"accepted","receipt_kind":"turn.acknowledged"}),
        ),
        "assistant.decision" => {
            standalone_decision(payload, &mut row);
            let label = row.get("public_decision_summary")?.clone();
            fields(
                &mut row,
                json!({"kind":"decision","safe_label":label,"state":"running"}),
            );
        }
        "work.block.started" | "work.block.updated" | "work.block.completed" => {
            work_decision(payload, &mut row);
            let title = optional(payload.get("decisionTitle"))
                .or_else(|| optional(payload.get("label").or_else(|| payload.get("safeLabel"))))
                .unwrap_or_else(|| "Working".into());
            let phase = kind.rsplit('.').next()?;
            let status = optional(payload.get("status"))
                .filter(|status| matches!(status.as_str(), "failed" | "cancelled"));
            let state = if let Some(status) = status.filter(|_| phase == "completed") {
                status
            } else if phase == "completed" {
                "delivered".into()
            } else {
                "running".into()
            };
            fields(
                &mut row,
                json!({"kind":"work_block","safe_label":title,"state":state,"work_block_id":optional(payload.get("workBlockId")).unwrap_or_else(||id.into()),"work_block_label":title,"work_block_phase":phase}),
            );
            if let Some(value) = block_sequence(payload) {
                row.insert("work_block_sequence".into(), value.into());
            }
        }
        "guard.started" | "guard.completed" => fields(
            &mut row,
            json!({"kind":"system","safe_label":if kind.ends_with("started"){"Checking response"}else{"Response checked"},"state":if kind.ends_with("started"){"running"}else{"delivered"}}),
        ),
        value if value.starts_with("tool.") => tool_row(value, payload, id, &mut row),
        "runtime.fault" => {
            let summary = safe(
                payload.get("publicSummary"),
                "Butler runtime was interrupted before the turn could continue.",
            );
            fields(
                &mut row,
                json!({"kind":"runtime_fault","safe_label":summary,"state":"runtime_fault","runtime_fault_id":safe(payload.get("faultId"),id),"runtime_fault_kind":safe(payload.get("kind"),"runtime_fault"),"runtime_fault_retryable":payload.get("retryable").and_then(Value::as_bool)==Some(true),"runtime_fault_public_summary":summary}),
            );
            copy(
                payload,
                &mut row,
                "safeErrorCode",
                "runtime_fault_safe_error_code",
            );
            copy(payload, &mut row, "safeCause", "runtime_fault_safe_cause");
        }
        "turn.accepted" | "turn.started" | "turn.iteration.started" => {
            let label = if kind == "turn.accepted" {
                "Accepted".into()
            } else {
                optional(payload.get("modelRef").or_else(|| payload.get("model")))
                    .unwrap_or_else(|| "Working on request".into())
            };
            fields(
                &mut row,
                json!({"kind":"turn","safe_label":label,"state":if kind=="turn.accepted"{"accepted"}else{"thinking"}}),
            );
            if kind == "turn.iteration.started" {
                row.insert("bridge_phase".into(), "model_round_waiting".into());
            }
        }
        "message.final.started" => fields(
            &mut row,
            json!({"kind":"message","safe_label":"Preparing final answer","state":"running"}),
        ),
        "message.final.completed" | "turn.completed" => fields(
            &mut row,
            json!({"kind":"turn","safe_label":if kind=="message.final.completed"{"Final answer ready"}else{"Completed"},"state":"delivered"}),
        ),
        "turn.failed" | "turn.cancelled" => fields(
            &mut row,
            json!({"kind":"turn","safe_label":if kind=="turn.failed"{safe(payload.get("safeLabel"),"Failed")}else{"Cancelled".into()},"state":if kind=="turn.failed"{"failed"}else{"cancelled"}}),
        ),
        _ => return None,
    }
    Some(row)
}

fn tool_row(kind: &str, p: &Map<String, Value>, id: &str, row: &mut Map<String, Value>) {
    if kind == "tool.progress" && p.get("activityKind").and_then(Value::as_str) == Some("todo") {
        let todo = optional(p.get("todoId").or_else(|| p.get("inputLabel")));
        fields(
            row,
            json!({"id":todo.as_deref().unwrap_or(id),"kind":"todo","safe_label":safe(p.get("safeLabel"),"Working step"),"state":optional(p.get("state")).unwrap_or_else(||"running".into())}),
        );
        insert(row, "safe_input_label", todo);
        copy(p, row, "bridgePhase", "bridge_phase");
        copy(p, row, "workstreamId", "work_stream_id");
        copy(p, row, "semanticBlockId", "semantic_block_id");
        details(p, row);
        integer(p, row, "safeOrder", "safe_order");
        return;
    }
    let tool = safe(p.get("toolName"), "Tool");
    let input = optional(p.get("inputLabel"));
    let fallback = input
        .as_ref()
        .map(|value| format!("{tool}: {value}"))
        .unwrap_or_else(|| tool.clone());
    let activity = optional(p.get("activityKind"))
        .filter(|value| {
            matches!(
                value.as_str(),
                "searched"
                    | "read"
                    | "ran_command"
                    | "edited"
                    | "dispatch"
                    | "used_tool"
                    | "context"
                    | "model"
                    | "message"
                    | "turn"
                    | "system"
            )
        })
        .unwrap_or_else(|| "used_tool".into());
    let state = match kind {
        "tool.failed" => "failed",
        "tool.cancelled" => "cancelled",
        "tool.completed" => "delivered",
        _ => "running",
    };
    fields(
        row,
        json!({"kind":activity,"safe_label":safe(p.get("safeLabel"),&fallback),"state":state,"safe_tool_name":tool}),
    );
    insert(row, "safe_input_label", input);
    copy(p, row, "toolCallId", "tool_call_id");
    copy(p, row, "resultId", "tool_result_id");
    integer(p, row, "resultByteLength", "tool_result_byte_length");
    copy(p, row, "bridgePhase", "bridge_phase");
    copy(p, row, "semanticBlockId", "semantic_block_id");
    copy(p, row, "workBlockId", "work_block_id");
    copy_object(p, row, "interfaceContent", "interface_content");
    copy(p, row, "interfaceLabelKey", "interface_label_key");
    work_decision(p, row);
    let block = optional(p.get("decisionTitle")).or_else(|| optional(p.get("workBlockLabel")));
    insert(row, "work_block_label", block);
    if let Some(value) = block_sequence(p) {
        row.insert("work_block_sequence".into(), value.into());
    }
    details(p, row);
}

fn work_decision(p: &Map<String, Value>, row: &mut Map<String, Value>) {
    contract(p, row);
    let source = optional(p.get("decisionSource").or_else(|| p.get("source")));
    let summary = optional(p.get("decisionSummary").or_else(|| p.get("summary")));
    if !public_source(source.as_deref()) || summary.is_none() {
        return;
    }
    copy(p, row, "decisionId", "work_decision_id");
    insert(
        row,
        "work_decision_title",
        optional(p.get("decisionTitle").or_else(|| p.get("blockTitle"))),
    );
    insert(row, "work_decision_summary", summary);
    insert(
        row,
        "work_decision_rationale",
        optional(p.get("decisionRationale").or_else(|| p.get("rationale"))),
    );
    insert(
        row,
        "work_decision_next_step",
        optional(p.get("decisionNextStep").or_else(|| p.get("nextStep"))),
    );
    insert(row, "work_decision_source", source);
    list(
        p,
        row,
        "decisionEvidenceRefs",
        "evidenceRefs",
        "work_decision_evidence_refs",
    );
}

fn standalone_decision(p: &Map<String, Value>, row: &mut Map<String, Value>) {
    let source = optional(p.get("source"));
    if !public_source(source.as_deref()) {
        return;
    }
    contract(p, row);
    copy(p, row, "role", "public_decision_role");
    copy(p, row, "summary", "public_decision_summary");
    copy(p, row, "rationale", "public_decision_rationale");
    copy(p, row, "nextStep", "public_decision_next_step");
    insert(row, "public_decision_source", source);
    copy(p, row, "modelCallId", "public_decision_model_call_id");
    integer(p, row, "latencyMs", "public_decision_latency_ms");
    list(p, row, "evidenceRefs", "", "public_decision_evidence_refs");
}

fn contract(p: &Map<String, Value>, row: &mut Map<String, Value>) {
    for (from, to) in [
        ("contractId", "work_contract_id"),
        ("workstreamId", "work_stream_id"),
        ("semanticBlockId", "semantic_block_id"),
        ("activityStage", "activity_stage"),
    ] {
        copy(p, row, from, to)
    }
}
fn details(p: &Map<String, Value>, row: &mut Map<String, Value>) {
    let Some(values) = p.get("detailRows").and_then(Value::as_array) else {
        return;
    };
    let output = values
        .iter()
        .filter_map(Value::as_object)
        .take(8)
        .enumerate()
        .filter_map(|(index, value)| {
            let mut item = service::map(json!({
                "id":safe(value.get("id"),&format!("detail-{}",index+1)),
                "safe_label":safe(value.get("safe_label"),"Detail")
            }))
            .ok()?;
            copy(value, &mut item, "kind", "kind");
            copy(value, &mut item, "safe_value", "safe_value");
            copy(value, &mut item, "state", "state");
            Some(Value::Object(item))
        })
        .collect::<Vec<_>>();
    if !output.is_empty() {
        row.insert("safe_detail_rows".into(), Value::Array(output));
    }
}
fn list(p: &Map<String, Value>, row: &mut Map<String, Value>, first: &str, second: &str, to: &str) {
    let values = p
        .get(first)
        .or_else(|| (!second.is_empty()).then(|| p.get(second)).flatten())
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| optional(Some(value)))
        .take(6)
        .map(Value::String)
        .collect::<Vec<_>>();
    if !values.is_empty() {
        row.insert(to.into(), Value::Array(values));
    }
}
fn block_sequence(p: &Map<String, Value>) -> Option<u64> {
    integer_value(p.get("blockSequence")).or_else(|| {
        optional(p.get("semanticBlockId")).and_then(|value| {
            value
                .rsplit_once(":block:")
                .and_then(|(_, suffix)| suffix.parse().ok())
        })
    })
}
fn base(id: &str, now: &str, sequence: Option<u64>) -> Option<Map<String, Value>> {
    service::map(json!({"id":id,"created_at":now,"turn_event_sequence":sequence})).ok()
}
fn fields(row: &mut Map<String, Value>, value: Value) {
    if let Some(values) = value.as_object() {
        row.extend(values.clone())
    }
}
fn copy(p: &Map<String, Value>, row: &mut Map<String, Value>, from: &str, to: &str) {
    insert(row, to, optional(p.get(from)))
}
fn copy_object(p: &Map<String, Value>, row: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = p.get(from).filter(|value| value.is_object()) {
        row.insert(to.into(), value.clone());
    }
}
fn insert(row: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        row.insert(key.into(), value.into());
    }
}
fn integer(p: &Map<String, Value>, row: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = integer_value(p.get(from)) {
        row.insert(to.into(), value.into());
    }
}
fn integer_value(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite() && *value >= 0.0)
    .map(|value| value.floor() as u64)
}
fn optional(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let value = match value {
        Value::String(value) => crate::public_text::sanitize_public_text(value, ""),
        Value::Number(_) | Value::Bool(_) => crate::public_text::sanitize_public_value(value, ""),
        _ => return None,
    };
    (!value.is_empty()).then_some(value)
}
fn safe(value: Option<&Value>, fallback: &str) -> String {
    value
        .map(|value| crate::public_text::sanitize_public_value(value, fallback))
        .unwrap_or_else(|| fallback.into())
}
fn public_source(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("assistant-authored" | "model-authored" | "principal-authored")
    )
}
