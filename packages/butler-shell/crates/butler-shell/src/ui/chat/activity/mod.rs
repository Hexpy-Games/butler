//! `TurnActivityTimeline/Panel/Block/Pending/Message`, `MessageTurnActivity`, `CompletedWorkBlocks`.
pub(crate) mod blocks;
pub(crate) mod operation;
mod project;
pub(crate) mod status;
pub(crate) mod steward;
pub(crate) mod timeline;
pub(crate) mod tools;

use gpui::{AnyElement, App, Window};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

/// A message's turn activity and completed work blocks; `None` when it has none.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn message_activity(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let turn_id = msg.turn_id.as_deref().filter(|id| !id.is_empty());
    let running = t
        .view
        .active_turn
        .as_ref()
        .is_some_and(|turn| Some(turn.id.as_str()) == turn_id);
    // The message's own activity rows; a settled message ends in its own status.
    let rows = msg.turn_activity_rows.as_deref().unwrap_or(&[]);
    let state = msg
        .status
        .as_deref()
        .filter(|status| !running && project::is_terminal(status));
    if let Some(timeline) = timeline::timeline_with(rows, turn_id, state, running, window, cx) {
        return Some(timeline);
    }
    // Completed work blocks stand in when the turn has no phase timeline.
    let blocks = msg.work_blocks.as_deref().unwrap_or(&[]);
    if running {
        return None;
    }
    blocks::collapsed_turn_activity(blocks, false, window, cx)
}
