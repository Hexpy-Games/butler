//! `app/conversation-progress/activity.ts`, `ordinary-activity-fallback.ts` and
//! `compact-display-title.ts`: a turn's progress rows projected for the activity timeline.
use std::collections::{HashMap, HashSet};

use butler_ds::ui::context::Lang;

use super::blocks::project_shared_work_blocks;
use super::ordinary::{compact_legacy_display_title, fallback_ordinary_activity};
use super::read_models::{ActivityReadModel, project_activity_read_models};
use super::row_ops::{is_terminal_state, merge_tool_rows};
use super::rows::visible_progress_rows;
use crate::ui::source::wire::{ProgressRow, WorkBlockView};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PhaseActivity {
    pub(crate) id: String,
    pub(crate) phase: Option<String>,
    pub(crate) title: String,
    pub(crate) summary: String,
    pub(crate) rationale: Option<String>,
    pub(crate) next_step: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) operations: Vec<ProgressRow>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TurnActivityProjection {
    pub(crate) visible_rows: Vec<ProgressRow>,
    pub(crate) read_models: Vec<ActivityReadModel>,
    pub(crate) work_blocks: Vec<WorkBlockView>,
    pub(crate) phase_activities: Vec<PhaseActivity>,
    pub(crate) public_activity: Option<ProgressRow>,
    pub(crate) semantic_state: Option<String>,
    pub(crate) model_round_wait: Option<ProgressRow>,
    pub(crate) operation: Option<ProgressRow>,
}

impl TurnActivityProjection {
    /// `decisions`: the decision read models.
    pub(crate) fn decisions(&self) -> impl Iterator<Item = &ActivityReadModel> {
        self.read_models
            .iter()
            .filter(|model| matches!(model, ActivityReadModel::Decision { .. }))
    }
}

pub(super) fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

/// `projectTurnActivity`.
pub(crate) fn project_turn_activity(
    lang: Lang,
    rows: &[ProgressRow],
    turn_id: Option<&str>,
) -> TurnActivityProjection {
    let ordered = ordered_progress_rows(visible_progress_rows(lang, rows));
    let visible_rows = merge_tool_rows(&ordered);
    let read_models = project_activity_read_models(lang, &visible_rows);
    let activity_rows: Vec<ProgressRow> = visible_rows
        .iter()
        .filter(|row| row.kind.as_deref() != Some("todo"))
        .cloned()
        .collect();
    let phase_activities = phase_activity_rows(&activity_rows);
    let work_blocks = project_work_blocks(&activity_rows);
    let projected = if phase_activities.is_empty() {
        fallback_ordinary_activity(lang, &activity_rows, turn_id)
    } else {
        phase_activities
    };
    TurnActivityProjection {
        public_activity: latest_public_activity(&activity_rows, !projected.is_empty()),
        semantic_state: current_semantic_state(&activity_rows, &projected),
        model_round_wait: current_model_round_wait(&activity_rows),
        operation: current_operation_activity(&activity_rows),
        visible_rows,
        read_models,
        work_blocks,
        phase_activities: projected,
    }
}

/// `projectWorkBlocks`.
pub(crate) fn project_work_blocks(rows: &[ProgressRow]) -> Vec<WorkBlockView> {
    project_shared_work_blocks(rows, false)
}

/// `projectCompletedWorkBlocks`.
pub(crate) fn project_completed_work_blocks(rows: &[ProgressRow]) -> Vec<WorkBlockView> {
    project_shared_work_blocks(rows, true)
}

fn is_phase_activity_row(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("message")
        && text(&row.work_block_id).is_none()
        && text(&row.semantic_block_id).is_some()
        && row.work_decision_source.as_deref() == Some("model-authored")
        && text(&row.work_decision_summary).is_some()
}

fn sorted_operations(mut operations: Vec<(usize, ProgressRow)>) -> Vec<ProgressRow> {
    operations.sort_by_key(|(at, _)| *at);
    operations.into_iter().map(|(_, row)| row).collect()
}

fn phase_activity_rows(rows: &[ProgressRow]) -> Vec<PhaseActivity> {
    let mut activities: Vec<PhaseActivity> = Vec::new();
    let authored: HashSet<&str> = rows
        .iter()
        .filter(|row| is_phase_activity_row(row))
        .filter_map(|row| text(&row.semantic_block_id))
        .collect();
    let mut current_by_block: HashMap<&str, usize> = HashMap::new();
    let mut before_activity: HashMap<&str, Vec<(usize, ProgressRow)>> = HashMap::new();
    let mut thinking_before: Vec<(usize, ProgressRow)> = Vec::new();
    for (position, row) in rows.iter().enumerate() {
        if is_phase_activity_row(row) {
            let block = text(&row.semantic_block_id).unwrap_or_default();
            let summary = row.work_decision_summary.clone().unwrap_or_default();
            let mut earlier = std::mem::take(&mut thinking_before);
            earlier.extend(before_activity.remove(block).unwrap_or_default());
            activities.push(PhaseActivity {
                id: row.id.clone(),
                phase: row.activity_stage.clone(),
                title: row
                    .work_decision_title
                    .clone()
                    .unwrap_or_else(|| compact_legacy_display_title(&summary)),
                summary,
                rationale: row.work_decision_rationale.clone(),
                next_step: row.work_decision_next_step.clone(),
                created_at: row.created_at.clone(),
                operations: sorted_operations(earlier),
            });
            current_by_block.insert(block, activities.len() - 1);
            continue;
        }
        if row.bridge_phase.as_deref() == Some("model_round_waiting")
            && text(&row.thinking_title).is_some()
        {
            match activities.last_mut() {
                Some(latest) => latest.operations.push(row.clone()),
                None => thinking_before.push((position, row.clone())),
            }
            continue;
        }
        let Some(block) = text(&row.semantic_block_id) else {
            continue;
        };
        if row.bridge_phase.as_deref() != Some("btcc_operation") {
            continue;
        }
        let target = current_by_block.get(block).copied().or_else(|| {
            (!authored.contains(block))
                .then(|| activities.len().checked_sub(1))
                .flatten()
        });
        match target {
            Some(at) => activities[at].operations.push(row.clone()),
            // Work acceptance can publish its operation before the accepted activity.
            None => before_activity
                .entry(block)
                .or_default()
                .push((position, row.clone())),
        }
    }
    activities
}

fn current_operation_activity(rows: &[ProgressRow]) -> Option<ProgressRow> {
    rows.iter()
        .rev()
        .find(|row| row.bridge_phase.as_deref() == Some("btcc_operation") && row.state == "running")
        .cloned()
}

fn current_model_round_wait(rows: &[ProgressRow]) -> Option<ProgressRow> {
    for row in rows.iter().rev() {
        if is_terminal_state(&row.state) {
            return None;
        }
        if row.bridge_phase.as_deref() == Some("model_round_waiting") {
            return Some(row.clone());
        }
        if row.work_decision_source.as_deref() == Some("model-authored")
            || row.bridge_phase.as_deref() == Some("operational_recovery")
        {
            return None;
        }
    }
    None
}

fn latest_public_activity(rows: &[ProgressRow], has_model_activity: bool) -> Option<ProgressRow> {
    rows.iter()
        .rev()
        .find(|row| {
            if row.kind.as_deref() != Some("message")
                || row.state != "running"
                || text(&row.work_block_id).is_some()
            {
                return false;
            }
            if row.bridge_phase.as_deref() == Some("model_round_waiting")
                || text(&row.work_decision_source).is_some()
            {
                return false;
            }
            if has_model_activity && row.bridge_phase.as_deref() != Some("operational_recovery") {
                return false;
            }
            !row.safe_label.trim().is_empty()
        })
        .cloned()
}

fn current_semantic_state(rows: &[ProgressRow], activities: &[PhaseActivity]) -> Option<String> {
    let latest_model_activity = rows.iter().rev().find(|row| {
        row.work_decision_source.as_deref() == Some("model-authored")
            || (row.kind.as_deref() == Some("message")
                && row.bridge_phase.as_deref() != Some("btcc_operation")
                && row.bridge_phase.as_deref() != Some("model_round_waiting")
                && text(&row.semantic_block_id).is_some())
    });
    if let Some(stage) = latest_model_activity.and_then(|row| text(&row.activity_stage)) {
        return Some(stage.to_string());
    }
    activities
        .last()
        .and_then(|activity| activity.phase.clone())
}

/// `orderedProgressRows`: by turn event sequence, when every row has one.
fn ordered_progress_rows(rows: Vec<ProgressRow>) -> Vec<ProgressRow> {
    if rows.iter().any(|row| row.turn_event_sequence.is_none()) {
        return rows;
    }
    let mut ordered = rows;
    ordered.sort_by_key(|row| row.turn_event_sequence.unwrap_or(0));
    ordered
}
