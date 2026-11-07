// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `Conversation`, `MessageList`, `TranscriptRows` and the scroll/virtualizer hooks.
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use super::TranscriptCtx;
use crate::ui::source::wire::SessionQueueView;

/// The transcript: rows in the ConversationShell list surface, auto-scroll and follow-latest.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn transcript(
    _t: &TranscriptCtx,
    _queue: Option<&SessionQueueView>,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}
