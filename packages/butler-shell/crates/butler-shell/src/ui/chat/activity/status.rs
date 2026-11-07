// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `CurrentTurnStatus`, `CurrentStatusText`, `CurrentModelRoundWaiting`, `AssistantStatusLabel`.
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use crate::ui::chat::TranscriptCtx;

/// The running turn's status line; `None` when no turn runs.
#[allow(dead_code, reason = "P2 shell-wave skeleton: wired by Opus at wave integration")]
pub(crate) fn current_turn_status(
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> Option<AnyElement> {
    None
}
