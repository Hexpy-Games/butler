//! `app/conversation-progress/progress-rows.ts`: which progress rows show, and the summary
//! rows of a turn.
#![allow(
    dead_code,
    reason = "P2 shell-wave: consumed by the units wired at wave integration"
)]
use std::collections::HashMap;

use butler_ds::ui::context::Lang;

use super::copy::localize_progress_row;
use super::row_ops::{is_terminal_state, minimum, overlay};
use crate::ui::source::wire::ProgressRow;

const INTERNAL_TOOL_NAMES: [&str; 4] = [
    "Update Todo List",
    "List Todo List",
    "Model preparation",
    "모델 준비",
];
const INTERNAL_RAW_TOOL_NAMES: [&str; 9] = [
    "update_todo_list",
    "list_todo_list",
    "model_preparation",
    "start_work",
    "continue_work",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
];
const LIFECYCLE_LABELS: [&str; 11] = [
    "accepted",
    "started",
    "thinking",
    "queued for butler service",
    "working on request",
    "checking response",
    "response checked",
    "preparing final answer",
    "final answer ready",
    "completed",
    "delivered",
];

fn is_internal_tool_name(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let trimmed = value.trim();
    let normalized = trimmed
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_");
    INTERNAL_TOOL_NAMES.contains(&trimmed) || INTERNAL_RAW_TOOL_NAMES.contains(&normalized.as_str())
}

/// `isInternalProgressRow`.
pub(crate) fn is_internal_progress_row(row: &ProgressRow) -> bool {
    is_internal_tool_name(row.safe_tool_name.as_deref())
        || is_internal_tool_name(Some(&row.safe_label))
        || is_internal_tool_name(row.safe_input_label.as_deref())
}

/// `visibleProgressRows`: the rows that are not internal, in the interface language.
pub(crate) fn visible_progress_rows(lang: Lang, rows: &[ProgressRow]) -> Vec<ProgressRow> {
    rows.iter()
        .filter(|row| !is_internal_progress_row(row))
        .map(|row| localize_progress_row(lang, row))
        .collect()
}

fn normalize(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_lowercase()
}

fn is_work_row(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("work_block")
        || (row
            .work_block_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
            && row
                .work_block_label
                .as_deref()
                .is_some_and(|label| !label.is_empty())
            && row.safe_tool_name.as_deref().is_none_or(str::is_empty))
}

fn is_lifecycle_message(row: &ProgressRow) -> bool {
    LIFECYCLE_LABELS.contains(&row.safe_label.trim().to_lowercase().as_str())
}

/// The last row per key, in the order each key first appeared (a `Map` filled by `set`).
fn dedupe_last(
    rows: Vec<&ProgressRow>,
    key_of: impl Fn(&ProgressRow) -> String,
) -> Vec<ProgressRow> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, &ProgressRow> = HashMap::new();
    for row in rows {
        let key = key_of(row);
        if by_key.insert(key.clone(), row).is_none() {
            order.push(key);
        }
    }
    order
        .iter()
        .filter_map(|key| by_key.get(key).map(|row| (*row).clone()))
        .collect()
}

fn last_n(rows: Vec<ProgressRow>, n: usize) -> Vec<ProgressRow> {
    let skip = rows.len().saturating_sub(n);
    rows.into_iter().skip(skip).collect()
}

/// `semanticProgressRows`.
pub(crate) fn semantic_progress_rows(lang: Lang, rows: &[ProgressRow]) -> Vec<ProgressRow> {
    let visible: Vec<ProgressRow> = visible_progress_rows(lang, rows)
        .into_iter()
        .filter(|row| row.bridge_phase.as_deref() != Some("model_round_waiting"))
        .collect();
    let todos = sorted_todo_rows(visible.iter().filter(|row| is_todo(row)).collect());
    if !todos.is_empty() {
        return todos.into_iter().take(8).collect();
    }
    let work = dedupe_last(
        visible.iter().filter(|row| is_work_row(row)).collect(),
        |row| {
            row.work_block_id
                .clone()
                .unwrap_or_else(|| row.safe_label.trim().to_lowercase())
        },
    );
    if !work.is_empty() {
        return last_n(work, 8);
    }
    let messages = dedupe_last(
        visible
            .iter()
            .filter(|row| row.kind.as_deref() == Some("message") && !is_lifecycle_message(row))
            .collect(),
        |row| {
            let label = row.safe_label.trim().to_lowercase();
            if label.is_empty() {
                row.id.clone()
            } else {
                label
            }
        },
    );
    last_n(messages, 8)
}

/// `summaryProgressRows`.
pub(crate) fn summary_progress_rows(lang: Lang, rows: &[ProgressRow]) -> Vec<ProgressRow> {
    let visible: Vec<ProgressRow> = visible_progress_rows(lang, rows)
        .into_iter()
        .filter(|row| row.bridge_phase.as_deref() != Some("model_round_waiting"))
        .collect();
    let todos = sorted_todo_rows(
        visible
            .iter()
            .filter(|row| is_todo(row) && row.bridge_phase.as_deref() == Some("btcc_work_ledger"))
            .collect(),
    );
    if !todos.is_empty() {
        return todos.into_iter().take(8).collect();
    }
    let work = dedupe_last(
        visible.iter().filter(|row| is_work_row(row)).collect(),
        |row| row.work_block_id.clone().unwrap_or_else(|| row.id.clone()),
    );
    if !work.is_empty() {
        return last_n(work, 8);
    }
    visible
        .iter()
        .rev()
        .find(|row| is_model_authored_activity(row))
        .map(|row| vec![row.clone()])
        .unwrap_or_default()
}

fn is_todo(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("todo")
}

fn has_text(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}

fn is_model_authored_activity(row: &ProgressRow) -> bool {
    if row.kind.as_deref() == Some("decision") {
        return row.public_decision_source.as_deref() == Some("model-authored")
            && has_text(&row.public_decision_summary);
    }
    row.kind.as_deref() == Some("message")
        && row.work_decision_source.as_deref() == Some("model-authored")
        && has_text(&row.work_decision_summary)
        && has_text(&row.work_decision_rationale)
        && has_text(&row.work_decision_next_step)
}

/// `sortedTodoRows`: one row per todo id, merged, ordered by `safe_order` then first seen.
fn sorted_todo_rows(rows: Vec<&ProgressRow>) -> Vec<ProgressRow> {
    let mut merged: Vec<(String, ProgressRow, usize)> = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        let id = normalize(row.safe_input_label.as_deref().or(Some(row.id.as_str())));
        if id.is_empty() {
            continue;
        }
        match merged.iter_mut().find(|(known, _, _)| *known == id) {
            Some(slot) => slot.1 = merge_todo_row(&slot.1, row),
            None => merged.push((id, row.clone(), index)),
        }
    }
    merged.sort_by(|left, right| {
        row_order(&left.1)
            .total_cmp(&row_order(&right.1))
            .then(left.2.cmp(&right.2))
    });
    merged.into_iter().map(|(_, row, _)| row).collect()
}

fn merge_todo_row(current: &ProgressRow, incoming: &ProgressRow) -> ProgressRow {
    let ledger = |row: &ProgressRow| row.bridge_phase.as_deref() == Some("btcc_work_ledger");
    let state = if ledger(current) && ledger(incoming) {
        incoming.state.clone()
    } else {
        merge_state(&current.state, &incoming.state)
    };
    let mut next = overlay(current, incoming);
    next.state = state;
    next.created_at = current
        .created_at
        .clone()
        .or_else(|| incoming.created_at.clone());
    next.safe_order = minimum(current.safe_order, incoming.safe_order);
    next
}

fn merge_state(current: &str, incoming: &str) -> String {
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

fn state_rank(state: &str) -> u8 {
    match state {
        "failed" | "cancelled" => 4,
        "delivered" | "complete" | "completed" => 3,
        "running" | "streaming" => 2,
        "thinking" | "accepted" => 1,
        _ => 0,
    }
}

fn row_order(row: &ProgressRow) -> f64 {
    row.safe_order
        .filter(|order| *order >= 0)
        .map_or(f64::INFINITY, |order| order as f64)
}
