//! `app/conversation-progress/terminal-activity.ts`: a settled turn's work blocks, kept on its
//! assistant message.
#![allow(
    dead_code,
    reason = "P2 shell-wave: consumed by the units wired at wave integration"
)]
use std::collections::HashMap;

use chrono::DateTime;

use super::activity::project_completed_work_blocks;
use super::row_ops::is_terminal_state;
use super::rows::is_internal_progress_row;
use crate::ui::source::wire::{
    MessageRecord, MessageRecordRole, ProgressRow, TurnProgressSnapshot, WorkBlockView,
};

const TOOL_ACTIVITY_KINDS: [&str; 6] = [
    "searched",
    "read",
    "ran_command",
    "edited",
    "dispatch",
    "used_tool",
];
const FIRST_PROGRESS_PREFIX: &str = "first-progress-";

/// `Date.parse`: milliseconds since the epoch, or `None` when the text is not a date.
fn parse_ms(value: Option<&str>) -> Option<f64> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|at| at.timestamp_millis() as f64)
}

/// `freezeConversationActivity`: freezes each message's activity from the turn snapshots;
/// returns whether any message changed.
pub(crate) fn freeze_conversation_activity(
    messages: &mut [MessageRecord],
    turn_progress: &HashMap<String, TurnProgressSnapshot>,
) -> bool {
    let mut changed = false;
    let mut segment_ends: HashMap<String, f64> = HashMap::new();
    for message in messages.iter_mut() {
        let turn_id = message.turn_id.clone().filter(|id| !id.is_empty());
        let snapshot = turn_id.as_ref().and_then(|id| turn_progress.get(id));
        let previous_end = turn_id
            .as_ref()
            .and_then(|id| segment_ends.get(id))
            .copied();
        let end = if message.status.as_deref() == Some("delivered") {
            parse_ms(message.updated_at.as_deref()).unwrap_or(f64::NAN)
        } else {
            f64::INFINITY
        };
        if let Some(id) = &turn_id
            && message.role == MessageRecordRole::Assistant
            && end.is_finite()
        {
            segment_ends.insert(id.clone(), end);
        }
        let segment = snapshot.map(|snapshot| {
            let mut segment = snapshot.clone();
            segment.safe_progress_rows.retain(|row| {
                let Some(at) = parse_ms(row.created_at.as_deref()) else {
                    return true;
                };
                previous_end.is_none_or(|previous| at > previous) && (!end.is_finite() || at <= end)
            });
            segment
        });
        let frozen = freeze_message_activity(message, segment.as_ref());
        if frozen != *message {
            *message = frozen;
            changed = true;
        }
    }
    changed
}

/// `freezeMessageActivity`.
pub(crate) fn freeze_message_activity(
    message: &MessageRecord,
    snapshot: Option<&TurnProgressSnapshot>,
) -> MessageRecord {
    if message.role != MessageRecordRole::Assistant
        || message.turn_id.as_deref().is_none_or(str::is_empty)
    {
        return message.clone();
    }
    let activity = freeze_phase_activity(message, snapshot);
    let mut clean = sanitize_work_blocks(activity);
    let blocks = completed_work_blocks(
        snapshot,
        terminal_state_from_status(message.status.as_deref()),
    );
    if blocks.is_empty() {
        if snapshot.is_some() && clean.work_blocks.as_ref().is_some_and(|b| !b.is_empty()) {
            clean.work_blocks = Some(Vec::new());
        }
        return clean;
    }
    if clean.work_blocks.as_ref() != Some(&blocks) {
        clean.work_blocks = Some(blocks);
    }
    clean
}

/// `completedWorkBlocks`.
pub(crate) fn completed_work_blocks(
    snapshot: Option<&TurnProgressSnapshot>,
    terminal_state_override: Option<&str>,
) -> Vec<WorkBlockView> {
    let Some(snapshot) = snapshot else {
        return Vec::new();
    };
    let state = terminal_state_override
        .or(snapshot.state.as_deref())
        .unwrap_or("");
    let rows: Vec<ProgressRow> = if is_terminal_state(state) {
        snapshot
            .safe_progress_rows
            .iter()
            .filter(|row| !is_first_visible_progress_row(row))
            .map(|row| {
                if is_terminal_state(&row.state) {
                    row.clone()
                } else {
                    ProgressRow {
                        state: state.to_string(),
                        ..row.clone()
                    }
                }
            })
            .collect()
    } else {
        snapshot.safe_progress_rows.clone()
    };
    project_completed_work_blocks(&rows)
        .into_iter()
        .filter(|block| {
            block
                .rows
                .iter()
                .any(|row| is_visible_tool_activity(row, &block.label))
        })
        .collect()
}

/// `isVisibleToolActivity`.
pub(crate) fn is_visible_tool_activity(row: &ProgressRow, block_label: &str) -> bool {
    let label = row.safe_label.trim();
    let block = block_label.trim();
    let tool_name = row.safe_tool_name.as_deref().map(str::trim);
    let has = |value: &Option<String>| value.as_deref().is_some_and(|text| !text.is_empty());
    let details = row
        .safe_detail_rows
        .as_ref()
        .is_some_and(|rows| !rows.is_empty());
    if is_internal_progress_row(row) || matches!(row.kind.as_deref(), Some("todo" | "message")) {
        return false;
    }
    if !label.is_empty() && label == block && !has(&row.tool_call_id) && !has(&row.safe_input_label)
    {
        return false;
    }
    if tool_name.is_some_and(|name| !name.is_empty() && name == block)
        && !has(&row.tool_call_id)
        && !has(&row.safe_input_label)
        && !details
    {
        return false;
    }
    has(&row.tool_call_id)
        || has(&row.safe_input_label)
        || details
        || TOOL_ACTIVITY_KINDS.contains(&row.kind.as_deref().unwrap_or(""))
}

fn freeze_phase_activity(
    message: &MessageRecord,
    snapshot: Option<&TurnProgressSnapshot>,
) -> MessageRecord {
    let Some(snapshot) = snapshot else {
        return message.clone();
    };
    let rows: Vec<ProgressRow> = snapshot
        .safe_progress_rows
        .iter()
        .filter(|row| is_retained_activity_row(row))
        .cloned()
        .collect();
    // A partial live/cache snapshot must not erase the gateway's settled history.
    let kept = message.turn_activity_rows.as_ref();
    if rows.is_empty() && kept.is_some_and(|kept| !kept.is_empty()) {
        return message.clone();
    }
    if kept == Some(&rows) {
        return message.clone();
    }
    MessageRecord {
        turn_activity_rows: Some(rows),
        ..message.clone()
    }
}

fn is_retained_activity_row(row: &ProgressRow) -> bool {
    let has = |value: &Option<String>| value.as_deref().is_some_and(|text| !text.is_empty());
    (row.kind.as_deref() == Some("todo") && row.bridge_phase.as_deref() == Some("btcc_work_ledger"))
        || (row.bridge_phase.as_deref() == Some("btcc_operation") && has(&row.semantic_block_id))
        || (row.kind.as_deref() == Some("message")
            && !has(&row.work_block_id)
            && has(&row.semantic_block_id)
            && row.work_decision_source.as_deref() == Some("model-authored")
            && has(&row.work_decision_summary))
}

fn sanitize_work_blocks(message: MessageRecord) -> MessageRecord {
    let Some(blocks) = &message.work_blocks else {
        return message;
    };
    let mut changed = false;
    let mut sanitized: Vec<WorkBlockView> = Vec::new();
    for block in blocks {
        let rows: Vec<ProgressRow> = block
            .rows
            .iter()
            .filter(|row| is_visible_tool_activity(row, &block.label))
            .cloned()
            .collect();
        if rows.is_empty() {
            changed = true;
        } else if rows.len() == block.rows.len() {
            sanitized.push(block.clone());
        } else {
            changed = true;
            sanitized.push(WorkBlockView {
                rows,
                ..block.clone()
            });
        }
    }
    if !changed {
        return message;
    }
    MessageRecord {
        work_blocks: (!sanitized.is_empty()).then_some(sanitized),
        ..message
    }
}

fn terminal_state_from_status(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("delivered") => Some("delivered"),
        Some("failed") => Some("failed"),
        _ => None,
    }
}

fn is_first_visible_progress_row(row: &ProgressRow) -> bool {
    row.kind.as_deref() == Some("message")
        && row
            .work_block_id
            .as_deref()
            .is_some_and(|id| id.starts_with(FIRST_PROGRESS_PREFIX))
}
