//! `TurnActivityTimeline/Panel/Block/Pending/Message`, `MessageTurnActivity`, `CompletedWorkBlocks`.
pub(crate) mod blocks;
pub(crate) mod operation;
pub(crate) mod status;
pub(crate) mod steward;
pub(crate) mod timeline;
pub(crate) mod tools;

use gpui::{AnyElement, App, Window};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;
use crate::ui::store::progress::row_ops::is_terminal_state;

/// `isGeneralChat`.
pub(crate) fn is_general_chat(chat_id: Option<&str>) -> bool {
    chat_id == Some("general")
}

/// A message's turn activity and completed work blocks; `None` when it has none, and always
/// `None` in the general chat, which shows the status line alone.
pub(crate) fn message_activity(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if is_general_chat(msg.chat_id.as_deref()) {
        return None;
    }
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
        .filter(|status| !running && is_terminal_state(status));
    if let Some(timeline) = timeline::timeline(rows, turn_id, state, running, t, window, cx) {
        return Some(timeline);
    }
    // Completed work blocks stand in when the turn has no phase timeline.
    if running {
        return None;
    }
    let blocks = msg.work_blocks.as_deref().unwrap_or(&[]);
    blocks::work_blocks(blocks, false, t, window, cx)
}
