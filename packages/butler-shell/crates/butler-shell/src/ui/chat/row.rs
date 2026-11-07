// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `MessageItem`, `VirtualMessageRow`, `MessageContent`.
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use super::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

/// One transcript message: the DS MessageRow by role, with the copy context menu.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn message_row(
    _msg: &MessageRecord,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}
