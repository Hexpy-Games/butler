//! `app/utils.ts`: merging progress rows and turn snapshots as live events and fresh views
//! arrive.
use std::collections::HashSet;

use chrono::DateTime;

use super::row_ops::{is_terminal_state, minimum, overlay};
use crate::ui::source::wire::{ProgressDetailRow, ProgressRow};

fn text(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn normalize(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_lowercase()
}

/// `Date.parse` in milliseconds.
pub(super) fn timestamp_ms(value: Option<&str>) -> Option<f64> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|at| at.timestamp_millis() as f64)
}

/// `shouldReviveProgressForRetry`.
pub(super) fn should_revive_for_retry(current: &str, incoming: &str) -> bool {
    current == "failed" && incoming == "retrying"
}

fn state_rank(state: &str) -> u8 {
    match state {
        "failed" | "cancelled" => 4,
        "delivered" | "complete" | "completed" => 3,
        "running" | "streaming" => 2,
        "thinking" | "accepted" => 1,
        _ => 0,
    }
}

/// `progressMergeState`.
pub(super) fn progress_merge_state(current: &str, incoming: &str) -> String {
    if is_terminal_state(incoming) || should_revive_for_retry(current, incoming) {
        return incoming.to_string();
    }
    if is_terminal_state(current) {
        return current.to_string();
    }
    // Waiting is a resumable Turn state, not lower-priority progress.
    if incoming == "waiting_for_form" || current == "waiting_for_form" {
        return incoming.to_string();
    }
    if state_rank(incoming) >= state_rank(current) {
        incoming.to_string()
    } else {
        current.to_string()
    }
}

/// `progressRowsForMergedTerminalState`: a delivered turn drops its superseded failure row.
pub(super) fn rows_for_merged_terminal_state(
    rows: Vec<ProgressRow>,
    state: Option<&str>,
) -> Vec<ProgressRow> {
    if !matches!(state, Some("delivered" | "complete" | "completed")) {
        return rows;
    }
    rows.into_iter()
        .filter(|row| !(row.kind.as_deref() == Some("turn") && row.state == "failed"))
        .collect()
}

fn todo_key(row: &ProgressRow) -> Option<String> {
    if row.kind.as_deref() != Some("todo") {
        return None;
    }
    let stable = normalize(row.safe_input_label.as_deref().or(Some(row.id.as_str())));
    (!stable.is_empty()).then(|| format!("id:{stable}"))
}

fn semantic_key(row: &ProgressRow) -> Option<String> {
    if matches!(row.kind.as_deref(), Some("message" | "system")) {
        return None;
    }
    if let Some(todo) = todo_key(row) {
        return Some(format!("todo:{todo}"));
    }
    let part = |value: Option<&str>| value.unwrap_or("").trim().to_lowercase();
    let parts = [
        part(row.kind.as_deref()),
        part(row.safe_tool_name.as_deref()),
        part(row.safe_input_label.as_deref()),
        part(Some(&row.safe_label)),
    ];
    (!row.safe_label.is_empty()).then(|| parts.join(":"))
}

fn direct_key(row: &ProgressRow) -> String {
    if row.kind.as_deref() == Some("work_block") && text(row.work_block_id.as_deref()).is_some() {
        return format!("work-event:{}", row.id);
    }
    if let Some(todo) = todo_key(row) {
        return format!("todo:{todo}");
    }
    if let Some(call) = text(row.tool_call_id.as_deref()) {
        return format!("tool:{call}");
    }
    match semantic_key(row) {
        Some(semantic) => format!("activity:{semantic}:row:{}", row.id),
        None => format!("row:{}", row.id),
    }
}

fn detail_rows_compatible(
    left: Option<&[ProgressDetailRow]>,
    right: Option<&[ProgressDetailRow]>,
) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        return true;
    };
    left.iter().all(|left_row| {
        let Some(right_row) = right.iter().find(|row| row.id == left_row.id) else {
            return true;
        };
        let (l, r) = (
            normalize(left_row.safe_value.as_deref()),
            normalize(right_row.safe_value.as_deref()),
        );
        l.is_empty() || r.is_empty() || l == r
    })
}

fn non_empty_details(row: &ProgressRow) -> Option<&[ProgressDetailRow]> {
    row.safe_detail_rows
        .as_deref()
        .filter(|rows| !rows.is_empty())
}

fn have_compatible_evidence(left: &ProgressRow, right: &ProgressRow) -> bool {
    let differs = |a: &Option<String>, b: &Option<String>| matches!((text(a.as_deref()), text(b.as_deref())), (Some(a), Some(b)) if a != b);
    if differs(&left.semantic_block_id, &right.semantic_block_id)
        || differs(&left.work_block_id, &right.work_block_id)
    {
        return false;
    }
    if !detail_rows_compatible(non_empty_details(left), non_empty_details(right)) {
        return false;
    }
    match (&left.safe_path_labels, &right.safe_path_labels) {
        (Some(left), Some(right)) if !left.is_empty() && !right.is_empty() => {
            let rights: HashSet<String> = right.iter().map(|path| normalize(Some(path))).collect();
            left.iter()
                .any(|path| rights.contains(&normalize(Some(path))))
        }
        _ => true,
    }
}

fn rows_semantically_match(left: &ProgressRow, right: &ProgressRow) -> bool {
    let skipped = |row: &ProgressRow| matches!(row.kind.as_deref(), Some("message" | "system"));
    if skipped(left) || skipped(right) || left.kind != right.kind {
        return false;
    }
    if !have_compatible_evidence(left, right) {
        return false;
    }
    if let (Some(a), Some(b)) = (semantic_key(left), semantic_key(right))
        && a == b
    {
        return true;
    }
    let tool = |row: &ProgressRow| normalize(row.safe_tool_name.as_deref());
    let input = |row: &ProgressRow| normalize(row.safe_input_label.as_deref());
    let (left_label, right_label) = (
        normalize(Some(&left.safe_label)),
        normalize(Some(&right.safe_label)),
    );
    let (left_tool, right_tool) = (tool(left), tool(right));
    let (left_input, right_input) = (input(left), input(right));
    if !left_label.is_empty() && left_label == right_label {
        let tools_compatible =
            left_tool.is_empty() || right_tool.is_empty() || left_tool == right_tool;
        let inputs_compatible =
            left_input.is_empty() || right_input.is_empty() || left_input == right_input;
        return tools_compatible && inputs_compatible;
    }
    !left_tool.is_empty()
        && !right_tool.is_empty()
        && !left_input.is_empty()
        && !right_input.is_empty()
        && left_tool == right_tool
        && left_input == right_input
}

fn is_canonical_work_task(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("todo") && row.bridge_phase.as_deref() == Some("btcc_work_ledger")
}

fn merge_row_state(current: &ProgressRow, incoming: &ProgressRow, revive: bool) -> String {
    if revive && current.state == "failed" && !is_terminal_state(&incoming.state) {
        return incoming.state.clone();
    }
    progress_merge_state(&current.state, &incoming.state)
}

/// `mergeProgressRow`.
fn merge_progress_row(current: &ProgressRow, incoming: &ProgressRow, revive: bool) -> ProgressRow {
    if is_canonical_work_task(current) && is_canonical_work_task(incoming) {
        let mut next = overlay(current, incoming);
        next.created_at.clone_from(&current.created_at);
        next.safe_order = minimum(current.safe_order, incoming.safe_order);
        return next;
    }
    let state = merge_row_state(current, incoming, revive);
    let mut next = if state == incoming.state {
        overlay(current, incoming)
    } else {
        overlay(incoming, current)
    };
    next.state = state;
    if next.safe_label.is_empty() {
        next.safe_label = if current.safe_label.is_empty() {
            incoming.safe_label.clone()
        } else {
            current.safe_label.clone()
        };
    }
    if current.kind.as_deref() == Some("todo") && incoming.kind.as_deref() == Some("todo") {
        next.safe_order = minimum(current.safe_order, incoming.safe_order);
    }
    next.turn_event_sequence = minimum(current.turn_event_sequence, incoming.turn_event_sequence);
    next.created_at = current
        .created_at
        .clone()
        .or_else(|| incoming.created_at.clone());
    next
}

fn keys_where(
    rows: &[(String, ProgressRow)],
    matches: impl Fn(&ProgressRow) -> bool,
) -> Vec<usize> {
    (0..rows.len()).filter(|at| matches(&rows[*at].1)).collect()
}

/// The slot of `incoming` among `by_key`: the row of its tool call, or the one open row it
/// semantically continues.
fn target_slot(
    by_key: &[(String, ProgressRow)],
    incoming: &ProgressRow,
    direct: &str,
) -> Option<usize> {
    let call = text(incoming.tool_call_id.as_deref());
    if let Some(call) = call
        && let Some(at) = by_key
            .iter()
            .position(|(_, row)| row.tool_call_id.as_deref() == Some(call))
    {
        return Some(at);
    }
    let sole = |slots: Vec<usize>| (slots.len() == 1).then(|| slots[0]);
    if call.is_some() && !by_key.iter().any(|(key, _)| key == direct) {
        return sole(keys_where(by_key, |candidate| {
            text(candidate.tool_call_id.as_deref()).is_none()
                && !is_terminal_state(&candidate.state)
                && rows_semantically_match(candidate, incoming)
        }));
    }
    if call.is_none() && !is_terminal_state(&incoming.state) {
        return sole(keys_where(by_key, |candidate| {
            text(candidate.tool_call_id.as_deref()).is_some()
                && rows_semantically_match(candidate, incoming)
        }));
    }
    None
}

fn upsert(by_key: &mut Vec<(String, ProgressRow)>, key: String, row: ProgressRow) {
    match by_key.iter_mut().find(|(known, _)| *known == key) {
        Some(slot) => slot.1 = row,
        None => by_key.push((key, row)),
    }
}

/// `mergeProgressRows`: the incoming rows merged into the current ones, by identity.
pub(crate) fn merge_progress_rows(
    current: &[ProgressRow],
    incoming: &[ProgressRow],
    revive: bool,
) -> Vec<ProgressRow> {
    let mut by_key: Vec<(String, ProgressRow)> = Vec::new();
    for row in current {
        upsert(&mut by_key, direct_key(row), row.clone());
    }
    for row in incoming {
        let direct = direct_key(row);
        let key = match target_slot(&by_key, row, &direct) {
            Some(at) => by_key[at].0.clone(),
            None => direct,
        };
        let merged = match by_key.iter().find(|(known, _)| *known == key) {
            Some((_, previous)) => merge_progress_row(previous, row, revive),
            None => row.clone(),
        };
        upsert(&mut by_key, key, merged);
    }
    by_key.into_iter().map(|(_, row)| row).collect()
}
