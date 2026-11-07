// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `TurnActivityTimeline/Panel/Block/Pending/Message`, `MessageTurnActivity`, `CompletedWorkBlocks`.
pub(crate) mod blocks;
pub(crate) mod operation;
pub(crate) mod status;
pub(crate) mod steward;
pub(crate) mod timeline;
pub(crate) mod tools;

use gpui::{AnyElement, App, IntoElement as _, Window, div};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

/// A message's turn activity and completed work blocks; `None` when it has none.
#[allow(dead_code, reason = "P2 shell-wave skeleton: wired by Opus at wave integration")]
pub(crate) fn message_activity(
    _msg: &MessageRecord,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> Option<AnyElement> {
    None
}
