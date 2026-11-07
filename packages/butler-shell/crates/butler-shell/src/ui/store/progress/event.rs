//! `progress-row-from-turn-event.ts`: the progress row one public turn event stands for.
#![allow(
    dead_code,
    reason = "P2 shell-wave: consumed by the units wired at wave integration"
)]
use serde_json::{Value, json};

use super::fields::{
    Payload, block_sequence, completed_block_state, detail_rows, first, label_parameters,
    optional_non_negative_integer, optional_text, progress_kind, read_interface_content, safe_text,
    set, standalone_decision_fields, work_block_phase, work_decision_fields,
};
use crate::ui::source::wire::{AgentTurnEvent, AgentTurnEventVisibility, ProgressRow};

fn row_from(fields: Payload) -> Option<ProgressRow> {
    serde_json::from_value(Value::Object(fields)).ok()
}

/// `eventRowBase` plus the row's `kind`, `safe_label` and `state`.
fn base(event: &AgentTurnEvent, kind: &str, label: &str, state: &str) -> Payload {
    let mut fields = Payload::new();
    fields.insert("id".into(), event.id.clone().into());
    set(&mut fields, "created_at", event.createdAt.clone());
    set(
        &mut fields,
        "turn_event_sequence",
        (event.turnSequence >= 0).then_some(event.turnSequence),
    );
    fields.insert("kind".into(), kind.into());
    fields.insert("safe_label".into(), label.into());
    fields.insert("state".into(), state.into());
    fields
}

fn public_note_row(event: &AgentTurnEvent, payload: &Payload) -> Option<ProgressRow> {
    let note = safe_text(payload.get("note"), "Working");
    let work_block_id = optional_text(payload.get("workBlockId"));
    let recovery = optional_text(payload.get("recoveryStatus"));
    let state = match recovery.as_deref() {
        Some("cleared") => "delivered",
        Some("interrupted") => "failed",
        _ => "running",
    };
    let mut fields = base(event, "message", &note, state);
    const TEXT_FIELDS: [(&str, &str); 7] = [
        ("interface_label_key", "interfaceLabelKey"),
        ("tool_call_id", "toolCallId"),
        ("tool_result_id", "resultId"),
        ("thinking_title", "thinkingTitle"),
        ("bridge_phase", "bridgePhase"),
        ("semantic_block_id", "semanticBlockId"),
        ("work_block_id", "workBlockId"),
    ];
    for (field, key) in TEXT_FIELDS {
        set(&mut fields, field, optional_text(payload.get(key)));
    }
    set(&mut fields, "safe_input_label", input_label);
    set(
        &mut fields,
        "tool_result_byte_length",
        optional_non_negative_integer(payload.get("resultByteLength")),
    );
    let block_label = decision
        .get("work_decision_title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| optional_text(payload.get("workBlockLabel")));
    set(&mut fields, "work_block_label", block_label);
    set(&mut fields, "work_block_sequence", block_sequence(payload));
    fields.extend(decision);
    set(
        &mut fields,
        "safe_detail_rows",
        detail_rows(payload.get("detailRows")),
    );
    row_from(fields)
}

fn fault_row(event: &AgentTurnEvent, payload: &Payload) -> Option<ProgressRow> {
    let summary = safe_text(
        payload.get("publicSummary"),
        "Butler runtime was interrupted before the turn could continue.",
    );
    let mut fields = base(event, "runtime_fault", &summary, "runtime_fault");
    fields.insert(
        "runtime_fault_id".into(),
        safe_text(payload.get("faultId"), &event.id).into(),
    );
    fields.insert(
        "runtime_fault_kind".into(),
        safe_text(payload.get("kind"), "runtime_fault").into(),
    );
    fields.insert(
        "runtime_fault_retryable".into(),
        Value::Bool(payload.get("retryable") == Some(&Value::Bool(true))),
    );
    fields.insert("runtime_fault_public_summary".into(), summary.into());
    set(
        &mut fields,
        "runtime_fault_safe_error_code",
        optional_text(payload.get("safeErrorCode")),
    );
    set(
        &mut fields,
        "runtime_fault_safe_cause",
        optional_text(payload.get("safeCause")),
    );
    row_from(fields)
}

fn turn_row(event: &AgentTurnEvent, payload: &Payload) -> Option<ProgressRow> {
    let kind = event.kind.as_str();
    match kind {
        "turn.accepted" | "turn.started" | "turn.iteration.started" => {
            let model = optional_text(first(payload, &["modelRef", "model"]));
            let label = if kind == "turn.accepted" {
                "Accepted".to_string()
            } else {
                model.unwrap_or_else(|| "Working on request".to_string())
            };
            let state = if kind == "turn.accepted" {
                "accepted"
            } else {
                "thinking"
            };
            let mut fields = base(event, "turn", &label, state);
            if kind == "turn.iteration.started" {
                fields.insert("bridge_phase".into(), "model_round_waiting".into());
            }
            row_from(fields)
        }
        "message.final.started" => {
            row_from(base(event, "message", "Preparing final answer", "running"))
        }
        "message.final.completed" | "turn.completed" => {
            let label = if kind == "message.final.completed" {
                "Final answer ready"
            } else {
                "Completed"
            };
            row_from(base(event, "turn", label, "delivered"))
        }
        "turn.failed" | "turn.cancelled" => {
            let failed = kind == "turn.failed";
            let label = if failed {
                safe_text(payload.get("safeLabel"), "Failed")
            } else {
                "Cancelled".to_string()
            };
            row_from(base(
                event,
                "turn",
                &label,
                if failed { "failed" } else { "cancelled" },
            ))
        }
        _ => None,
    }
}

/// `progressRowFromSharedTurnEvent`: the row a public turn event adds, if any.
pub(crate) fn progress_row_from_turn_event(event: &AgentTurnEvent) -> Option<ProgressRow> {
    if matches!(event.visibility, Some(AgentTurnEventVisibility::Internal)) {
        return None;
    }
    let empty = Payload::new();
    let payload = event
        .payload
        .as_ref()
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let kind = event.kind.as_str();
    if kind == "assistant.public_note" {
        return public_note_row(event, payload);
    }
    if kind == "turn.first_progress" {
        let label = safe_text(first(payload, &["note", "safeLabel"]), "Working");
        return row_from(base(event, "turn", &label, "thinking"));
    }
    if kind == "turn.acknowledged" {
        let label = safe_text(
            payload.get("safeLabel"),
            "Request received. Preparing the work.",
        );
        let mut fields = base(event, "turn", &label, "accepted");
        fields.insert("receipt_kind".into(), "turn.acknowledged".into());
        return row_from(fields);
    }
    if kind == "assistant.decision" {
        let decision = standalone_decision_fields(payload);
        let summary = decision
            .get("public_decision_summary")?
            .as_str()?
            .to_string();
        decision.get("public_decision_source")?;
        let mut fields = base(event, "decision", &summary, "running");
        fields.extend(decision);
        return row_from(fields);
    }
    if let Some(phase) = work_block_phase(kind) {
        return work_block_row(event, payload, phase);
    }
    if kind == "guard.started" || kind == "guard.completed" {
        let started = kind == "guard.started";
        let label = if started {
            "Checking response"
        } else {
            "Response checked"
        };
        return row_from(base(
            event,
            "system",
            label,
            if started { "running" } else { "delivered" },
        ));
    }
    if kind.starts_with("tool.") {
        return tool_row(event, payload);
    }
    if kind == "runtime.fault" {
        return fault_row(event, payload);
    }
    turn_row(event, payload)
}
