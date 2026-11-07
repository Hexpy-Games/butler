// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! Answer blocks: timeline, checklist, progress, text, image, quote, facts, metrics, callout, actions.
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::AnswerBlock;

/// Renders one block of this family (timeline, checklist, progress, text, image, quote, facts, metrics, callout, actions).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(super) fn render(
    _block: &AnswerBlock,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}
