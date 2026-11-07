//! `shared-progress-row-operations.ts` and the row spreads of `utils.ts`: merging and folding
//! progress rows.
use std::collections::HashMap;

use crate::ui::source::wire::ProgressRow;

const TOOL_ACTIVITY_KINDS: [&str; 9] = [
    "searched",
    "read",
    "ran_command",
    "edited",
    "dispatch",
    "used_tool",
    "context",
    "model",
    "explored",
];
const INTERNAL_NAMES: [&str; 7] = [
    "Update Todo List",
    "List Todo List",
    "Model preparation",
    "모델 준비",
    "update_todo_list",
    "list_todo_list",
    "model_preparation",
];

/// `{...base, ...top}`: each field `top` holds replaces `base`'s (a missing field keeps it).
pub(crate) fn overlay(base: &ProgressRow, top: &ProgressRow) -> ProgressRow {
    macro_rules! layered {
        ($($field:ident),* $(,)?) => {
            ProgressRow {
                id: top.id.clone(),
                state: top.state.clone(),
                safe_label: top.safe_label.clone(),
                $($field: top.$field.clone().or_else(|| base.$field.clone()),)*
            }
        };
    }
    layered!(
        action_key,
        failure_code,
        auth_type,
        turn_id,
        kind,
        turn_event_sequence,
        safe_tool_name,
        safe_input_label,
        tool_call_id,
        thinking_title,
        thinking_body,
        tool_result_id,
        tool_result_byte_length,
        bridge_phase,
        interface_label_key,
        interface_content,
        interface_label_parameters,
        receipt_kind,
        public_decision_role,
        public_decision_summary,
        public_decision_rationale,
        public_decision_next_step,
        public_decision_source,
        public_decision_model_call_id,
        public_decision_latency_ms,
        public_decision_evidence_refs,
        work_contract_id,
        work_stream_id,
        semantic_block_id,
        activity_stage,
        work_block_id,
        work_block_label,
        work_block_phase,
        work_block_sequence,
        work_decision_id,
        work_decision_title,
        work_decision_summary,
        work_decision_rationale,
        work_decision_next_step,
        work_decision_source,
        work_decision_evidence_refs,
        runtime_fault_id,
        runtime_fault_kind,
        runtime_fault_retryable,
        runtime_fault_public_summary,
        runtime_fault_safe_error_code,
        runtime_fault_safe_cause,
        safe_path_labels,
        safe_detail_rows,
        safe_order,
        created_at,
    )
}

/// `stripBlockFields`.
pub(crate) fn strip_block_fields(row: &ProgressRow) -> ProgressRow {
    let mut row = row.clone();
    row.work_block_id = None;
    row.work_block_label = None;
    row.work_block_phase = None;
    row.work_block_sequence = None;
    row.work_decision_id = None;
    row.work_decision_title = None;
    row.work_decision_summary = None;
    row.work_decision_rationale = None;
    row.work_decision_next_step = None;
    row.work_decision_source = None;
    row.work_decision_evidence_refs = None;
    row
}

/// `minimumOptionalNumber`.
pub(crate) fn minimum(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

/// `isTerminalProgressState`.
pub(crate) fn is_terminal_state(state: &str) -> bool {
    matches!(
        state,
        "failed" | "cancelled" | "delivered" | "complete" | "completed" | "stopped"
    )
}

fn state_rank(state: &str) -> u8 {
    match state {
        "running" | "streaming" => 2,
        "thinking" | "accepted" => 1,
        _ => 0,
    }
}

/// `mergeProgressState` of the shared reducer.
pub(crate) fn shared_merge_state(current: &str, incoming: &str) -> String {
    if is_terminal_state(incoming) {
        return incoming.to_string();
    }
    if is_terminal_state(current) {
        return current.to_string();
    }
    if state_rank(incoming) >= state_rank(current) {
        incoming.to_string()
    } else {
        current.to_string()
    }
}

/// `mergeToolRow`.
pub(crate) fn merge_tool_row(current: &ProgressRow, incoming: &ProgressRow) -> ProgressRow {
    let state = shared_merge_state(&current.state, &incoming.state);
    let incoming_wins = state == incoming.state;
    let stripped = strip_block_fields(incoming);
    let mut merged = if incoming_wins {
        overlay(current, &stripped)
    } else {
        overlay(&stripped, current)
    };
    merged.state = state;
    merged.created_at = current
        .created_at
        .clone()
        .or_else(|| incoming.created_at.clone());
    merged.turn_event_sequence = minimum(current.turn_event_sequence, incoming.turn_event_sequence);
    merged
}

fn truthy(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// `mergeToolRows`: lifecycle events folded by durable call identity.
pub(crate) fn merge_tool_rows(rows: &[ProgressRow]) -> Vec<ProgressRow> {
    let mut positions: HashMap<&str, usize> = HashMap::new();
    let mut result: Vec<ProgressRow> = Vec::new();
    for row in rows {
        let key = truthy(row.tool_call_id.as_deref());
        match key.and_then(|key| positions.get(key).copied()) {
            Some(at) => result[at] = merge_tool_row(&result[at], row),
            None => {
                if let Some(key) = key {
                    positions.insert(key, result.len());
                }
                result.push(row.clone());
            }
        }
    }
    result
}

/// `isLegacyDecisionCarrier`.
pub(crate) fn is_legacy_decision_carrier(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("message")
        && truthy(row.work_block_id.as_deref()).is_some()
        && truthy(row.work_block_label.as_deref()).is_some()
}

/// `isToolActivityRow`.
pub(crate) fn is_tool_activity_row(row: &ProgressRow) -> bool {
    let kind = row.kind.as_deref().unwrap_or("");
    if matches!(
        kind,
        "todo" | "message" | "system" | "thinking" | "worked_duration"
    ) {
        return false;
    }
    let internal = |value: &str| INTERNAL_NAMES.contains(&value);
    if internal(row.safe_tool_name.as_deref().unwrap_or(""))
        || internal(&row.safe_label)
        || internal(row.safe_input_label.as_deref().unwrap_or(""))
    {
        return false;
    }
    if kind == "dispatch" && truthy(row.tool_call_id.as_deref()).is_none() {
        return false;
    }
    truthy(row.tool_call_id.as_deref()).is_some()
        || truthy(row.safe_input_label.as_deref()).is_some()
        || row
            .safe_detail_rows
            .as_ref()
            .is_some_and(|rows| !rows.is_empty())
        || TOOL_ACTIVITY_KINDS.contains(&kind)
}

/// `projectionOrder`: the turn event sequence, else the safe order, else last.
fn projection_order(row: &ProgressRow) -> f64 {
    [row.turn_event_sequence, row.safe_order]
        .into_iter()
        .flatten()
        .find(|order| *order >= 0)
        .map_or(f64::INFINITY, |order| order as f64)
}

/// `sortProjectionRows`: a stable sort by [`projection_order`].
pub(crate) fn sort_projection_rows(rows: &[ProgressRow]) -> Vec<&ProgressRow> {
    let mut sorted: Vec<&ProgressRow> = rows.iter().collect();
    sorted.sort_by(|left, right| projection_order(left).total_cmp(&projection_order(right)));
    sorted
}
