//! `ordinary-activity-fallback.ts` and `compact-display-title.ts`.
use std::collections::HashSet;

use butler_ds::ui::context::Lang;

use super::activity::{PhaseActivity, text};
use super::copy::copy;
use super::row_ops::merge_tool_rows;
use crate::ui::source::wire::ProgressRow;

const LEGACY_DISPLAY_TITLE_LENGTH: usize = 24;

/// `compactLegacyDisplayTitle` (by characters; the app measures graphemes).
pub(super) fn compact_legacy_display_title(value: &str) -> String {
    let title = value.trim();
    if title.chars().count() <= LEGACY_DISPLAY_TITLE_LENGTH {
        return title.to_string();
    }
    let head: String = title.chars().take(LEGACY_DISPLAY_TITLE_LENGTH).collect();
    format!("{head}…")
}

/// `fallbackOrdinaryActivity`: orphan ordinary-tool rows grouped for presentation, scoped to
/// one turn.
pub(super) fn fallback_ordinary_activity(
    lang: Lang,
    rows: &[ProgressRow],
    turn_id: Option<&str>,
) -> Vec<PhaseActivity> {
    let Some(resolved) = resolve_turn_id(rows, turn_id) else {
        return Vec::new();
    };
    let operations = dedupe_ordinary_operations(rows, &resolved);
    let Some(first) = operations.first() else {
        return Vec::new();
    };
    let working = copy(lang).working.to_string();
    vec![PhaseActivity {
        id: text(first.semantic_block_id.as_deref())
            .map_or_else(|| format!("turn:{resolved}:ordinary"), str::to_string),
        phase: None,
        title: working.clone(),
        summary: working,
        rationale: None,
        next_step: None,
        created_at: first.created_at.clone(),
        operations: operations.clone(),
    }]
}

fn resolve_turn_id(rows: &[ProgressRow], turn_id: Option<&str>) -> Option<String> {
    if let Some(explicit) = turn_id.map(str::trim).filter(|id| !id.is_empty()) {
        return Some(explicit.to_string());
    }
    let ids: HashSet<&str> = rows
        .iter()
        .filter_map(|row| row.turn_id.as_deref())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect();
    (ids.len() == 1)
        .then(|| ids.into_iter().next().map(str::to_string))
        .flatten()
}

fn dedupe_ordinary_operations(rows: &[ProgressRow], turn_id: &str) -> Vec<ProgressRow> {
    let mut seen_calls: HashSet<String> = HashSet::new();
    let mut seen_rows: HashSet<String> = HashSet::new();
    let mut operations = Vec::new();
    for row in merge_tool_rows(rows) {
        let ordinary = row.bridge_phase.as_deref() == Some("btcc_operation")
            || (row.bridge_phase.as_deref() == Some("model_round_waiting")
                && text(row.thinking_title.as_deref()).is_some());
        let other_turn = row
            .turn_id
            .as_deref()
            .is_some_and(|id| id.trim() != turn_id);
        if !ordinary
            || other_turn
            || text(row.work_block_id.as_deref()).is_some()
            || text(row.work_contract_id.as_deref()).is_some()
            || text(row.work_stream_id.as_deref()).is_some()
        {
            continue;
        }
        let call = row
            .tool_call_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if seen_rows.contains(&row.id) || call.is_some_and(|call| seen_calls.contains(call)) {
            continue;
        }
        seen_rows.insert(row.id.clone());
        if let Some(call) = call {
            seen_calls.insert(call.to_string());
        }
        operations.push(row);
    }
    operations
}
