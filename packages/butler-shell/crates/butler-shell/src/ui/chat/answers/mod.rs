// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! The 18 answer-block types (React `AnswerBlocks.tsx` switch).
mod cards;
mod containers;
mod data;
mod frame;
mod leaf;

use gpui::{AnyElement, App, IntoElement as _, Window, div};

use super::TranscriptCtx;
use crate::ui::source::wire::{AnswerBlock, AnswerBlockSet};

/// `AnswerBlocks`: a message's answer-block sets.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn answer_blocks(
    _sets: &[AnswerBlockSet],
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}

/// One block: dispatches to its family and wraps it in the frame. Containers call it for
/// their children.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(super) fn block(
    block: &AnswerBlock,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (
        &containers::render,
        &leaf::render,
        &cards::render,
        &data::render,
    );
    frame::frame(div().into_any_element(), block, t, window, cx)
}
