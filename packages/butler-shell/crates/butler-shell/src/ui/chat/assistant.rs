// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `AssistantMessageBody`, `AssistantReply`, footers, failure notice, retry, branch, trace.
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use super::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

/// The assistant message body.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn assistant_body(
    _msg: &MessageRecord,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}
