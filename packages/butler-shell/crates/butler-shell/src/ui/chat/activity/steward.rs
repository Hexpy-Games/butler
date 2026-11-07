// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `StewardParentProgress` and its presentation/projection.
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

/// Steward children progress under a message; `None` when there is none.
#[allow(dead_code, reason = "P2 shell-wave skeleton: wired by Opus at wave integration")]
pub(crate) fn steward_progress(
    _msg: &MessageRecord,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> Option<AnyElement> {
    None
}
