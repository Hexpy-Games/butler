//! `projectTurnActivity` (app/conversation-progress/activity.ts) for the rows the timeline and
//! work blocks show: the phase activities, the current semantic state, and the copy they use.
use std::collections::{HashMap, HashSet};

use butler_ds::ui::context::Lang;

use crate::ui::source::wire::ProgressRow;

/// `PhaseActivity`.
#[derive(Clone)]
pub(super) struct PhaseActivity {
    pub(super) id: String,
    pub(super) phase: Option<String>,
    pub(super) title: String,
    pub(super) summary: String,
    pub(super) rationale: Option<String>,
    pub(super) next_step: Option<String>,
    pub(super) created_at: Option<String>,
    pub(super) operations: Vec<ProgressRow>,
}

/// The consumed part of `TurnActivityProjection`.
pub(super) struct Projection {
    pub(super) phase_activities: Vec<PhaseActivity>,
    pub(super) semantic_state: Option<String>,
}

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

pub(super) fn is_terminal(state: &str) -> bool {
    matches!(
        state,
        "failed" | "cancelled" | "delivered" | "complete" | "completed" | "stopped"
    )
}

fn rank(state: &str) -> u8 {
    match state {
        "running" | "streaming" => 2,
        "thinking" | "accepted" => 1,
        _ => 0,
    }
}

fn has(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.is_empty())
}

fn is_internal_name(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| {
        let trimmed = v.trim();
        let normalized = trimmed
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("_");
        INTERNAL_TOOL_NAMES.contains(&trimmed)
            || INTERNAL_RAW_TOOL_NAMES.contains(&normalized.as_str())
    })
}

/// `isInternalProgressRow`.
fn is_internal(row: &ProgressRow) -> bool {
    is_internal_name(&row.safe_tool_name)
        || is_internal_name(&Some(row.safe_label.clone()))
        || is_internal_name(&row.safe_input_label)
}

/// `mergeToolRows`: rows of one tool call fold into the first one's place.
fn merge_tool_rows(rows: Vec<ProgressRow>) -> Vec<ProgressRow> {
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut result: Vec<ProgressRow> = Vec::new();
    for row in rows {
        let key = row.tool_call_id.clone().filter(|k| !k.is_empty());
        match key.as_ref().and_then(|k| positions.get(k)).copied() {
            Some(index) => merge_tool_row(&mut result[index], row),
            None => {
                if let Some(key) = key {
                    positions.insert(key, result.len());
                }
                result.push(row);
            }
        }
    }
    result
}

fn merge_tool_row(current: &mut ProgressRow, incoming: ProgressRow) {
    let state = if is_terminal(&incoming.state) {
        incoming.state.clone()
    } else if is_terminal(&current.state) || rank(&incoming.state) < rank(&current.state) {
        current.state.clone()
    } else {
        incoming.state.clone()
    };
    let created_at = current
        .created_at
        .clone()
        .or_else(|| incoming.created_at.clone());
    let sequence = match (current.turn_event_sequence, incoming.turn_event_sequence) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    if state == incoming.state {
        *current = incoming;
    }
    current.state = state;
    current.created_at = created_at;
    current.turn_event_sequence = sequence;
}

/// `orderedProgressRows`.
fn ordered(mut rows: Vec<ProgressRow>) -> Vec<ProgressRow> {
    if rows.iter().any(|r| r.turn_event_sequence.is_none()) {
        return rows;
    }
    rows.sort_by_key(|r| r.turn_event_sequence.unwrap_or(0));
    rows
}

fn is_phase_row(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("message")
        && !has(&row.work_block_id)
        && has(&row.semantic_block_id)
        && row.work_decision_source.as_deref() == Some("model-authored")
        && has(&row.work_decision_summary)
}

/// `compactLegacyDisplayTitle`: 24 characters, then an ellipsis.
fn compact_title(value: &str) -> String {
    let title = value.trim();
    if title.chars().count() <= 24 {
        return title.to_string();
    }
    format!("{}…", title.chars().take(24).collect::<String>())
}

fn phase_activities(rows: &[ProgressRow]) -> Vec<PhaseActivity> {
    let mut activities: Vec<PhaseActivity> = Vec::new();
    let authored: HashSet<&str> = rows
        .iter()
        .filter(|r| is_phase_row(r))
        .filter_map(|r| r.semantic_block_id.as_deref())
        .collect();
    let mut current: HashMap<String, usize> = HashMap::new();
    let mut before: HashMap<String, Vec<ProgressRow>> = HashMap::new();
    let mut thinking_before: Vec<ProgressRow> = Vec::new();
    for row in rows {
        if is_phase_row(row) {
            let block = row.semantic_block_id.clone().unwrap_or_default();
            let summary = row.work_decision_summary.clone().unwrap_or_default();
            let mut operations = std::mem::take(&mut thinking_before);
            operations.extend(before.remove(&block).unwrap_or_default());
            activities.push(PhaseActivity {
                id: row.id.clone(),
                phase: row.activity_stage.clone(),
                title: row
                    .work_decision_title
                    .clone()
                    .unwrap_or_else(|| compact_title(&summary)),
                summary,
                rationale: row.work_decision_rationale.clone(),
                next_step: row.work_decision_next_step.clone(),
                created_at: row.created_at.clone(),
                operations,
            });
            current.insert(block, activities.len() - 1);
            continue;
        }
        if row.bridge_phase.as_deref() == Some("model_round_waiting") && has(&row.thinking_title) {
            match activities.last_mut() {
                Some(latest) => latest.operations.push(row.clone()),
                None => thinking_before.push(row.clone()),
            }
            continue;
        }
        let Some(block) = row.semantic_block_id.clone().filter(|b| !b.is_empty()) else {
            continue;
        };
        if row.bridge_phase.as_deref() != Some("btcc_operation") {
            continue;
        }
        let target = current.get(&block).copied().or_else(|| {
            (!authored.contains(block.as_str()))
                .then(|| activities.len().checked_sub(1))
                .flatten()
        });
        match target {
            Some(index) => activities[index].operations.push(row.clone()),
            None => before.entry(block).or_default().push(row.clone()),
        }
    }
    activities
}

/// `fallbackOrdinaryActivity`: orphan ordinary-tool rows grouped as one working activity.
fn fallback_ordinary(
    rows: &[ProgressRow],
    turn_id: Option<&str>,
    lang: Lang,
) -> Vec<PhaseActivity> {
    let explicit = turn_id.map(str::trim).filter(|t| !t.is_empty());
    let row_turns: HashSet<&str> = rows
        .iter()
        .filter_map(|r| r.turn_id.as_deref().map(str::trim))
        .filter(|t| !t.is_empty())
        .collect();
    let resolved = match explicit {
        Some(turn) => turn.to_string(),
        None if row_turns.len() == 1 => row_turns
            .iter()
            .next()
            .map(|t| (*t).to_string())
            .unwrap_or_default(),
        None => return Vec::new(),
    };
    let mut seen_calls: HashSet<String> = HashSet::new();
    let mut seen_rows: HashSet<String> = HashSet::new();
    let mut operations: Vec<ProgressRow> = Vec::new();
    for row in merge_tool_rows(rows.to_vec()) {
        let operation = row.bridge_phase.as_deref() == Some("btcc_operation")
            || (row.bridge_phase.as_deref() == Some("model_round_waiting")
                && has(&row.thinking_title));
        let other_turn = row.turn_id.as_deref().is_some_and(|t| t.trim() != resolved);
        if !operation
            || other_turn
            || has(&row.work_block_id)
            || has(&row.work_contract_id)
            || has(&row.work_stream_id)
        {
            continue;
        }
        let call = row
            .tool_call_id
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_string);
        if seen_rows.contains(&row.id) || call.as_ref().is_some_and(|c| seen_calls.contains(c)) {
            continue;
        }
        seen_rows.insert(row.id.clone());
        if let Some(call) = call {
            seen_calls.insert(call);
        }
        operations.push(row);
    }
    let Some(first) = operations.first() else {
        return Vec::new();
    };
    let working = phase_label(lang, None).to_string();
    vec![PhaseActivity {
        id: first
            .semantic_block_id
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map_or_else(|| format!("turn:{resolved}:ordinary"), str::to_string),
        phase: None,
        title: working.clone(),
        summary: working,
        rationale: None,
        next_step: None,
        created_at: first.created_at.clone(),
        operations,
    }]
}

fn current_semantic_state(rows: &[&ProgressRow], activities: &[PhaseActivity]) -> Option<String> {
    let latest = rows.iter().rev().find(|r| {
        r.work_decision_source.as_deref() == Some("model-authored")
            || (r.kind.as_deref() == Some("message")
                && !matches!(
                    r.bridge_phase.as_deref(),
                    Some("btcc_operation" | "model_round_waiting")
                )
                && has(&r.semantic_block_id))
    });
    if let Some(stage) = latest
        .and_then(|r| r.activity_stage.clone())
        .filter(|s| !s.is_empty())
    {
        return Some(stage);
    }
    activities.last().and_then(|a| a.phase.clone())
}

/// `projectTurnActivity`.
pub(super) fn project(rows: &[ProgressRow], turn_id: Option<&str>, lang: Lang) -> Projection {
    let visible: Vec<ProgressRow> = rows.iter().filter(|r| !is_internal(r)).cloned().collect();
    let visible = merge_tool_rows(ordered(visible));
    let activity_rows: Vec<ProgressRow> = visible
        .into_iter()
        .filter(|r| r.kind.as_deref() != Some("todo"))
        .collect();
    let mut activities = phase_activities(&activity_rows);
    if activities.is_empty() {
        activities = fallback_ordinary(&activity_rows, turn_id, lang);
    }
    let refs: Vec<&ProgressRow> = activity_rows.iter().collect();
    Projection {
        semantic_state: current_semantic_state(&refs, &activities),
        phase_activities: activities,
    }
}

/// `phaseLabel` (interfaceStatus.*).
pub(super) fn phase_label(lang: Lang, phase: Option<&str>) -> &'static str {
    let ko = lang == Lang::Ko;
    let pick = |en: &'static str, kr: &'static str| if ko { kr } else { en };
    let Some(phase) = phase.filter(|p| !p.is_empty()) else {
        return pick("Working", "작업 중");
    };
    match phase {
        "delivered" | "completed" => pick("Completed", "완료"),
        "failed" | "runtime_fault" => pick("Failed", "실패"),
        "cancelled" => pick("Stopped", "중단"),
        p if p.starts_with("conception") => pick("Conception", "구상"),
        "contract_review" => pick("Conception review", "구상 검토"),
        "planning" => pick("Planning", "계획"),
        "planning_review" => pick("Plan review", "계획 검토"),
        "task_execution" | "execution" => pick("Execution", "실행"),
        "task_review" | "review" => pick("Task review", "작업 리뷰"),
        "validation" => pick("Completion review", "완료 검토"),
        p if p.starts_with("feedback_") => pick("Applying feedback", "피드백 반영"),
        "consolidation" => pick("Consolidation", "통합 점검"),
        "reporting" => pick("Reporting", "보고"),
        _ => pick("Working", "작업 중"),
    }
}
