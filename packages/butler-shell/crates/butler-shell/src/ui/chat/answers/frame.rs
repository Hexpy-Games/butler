// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `AnswerBlockFrame`, `answerBlockActions`, `AnswerItem`, `AnswerSourceLine`.
use gpui::{AnyElement, App, Window};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::AnswerBlock;

/// Wraps a rendered block in its action frame (save to library, superseded dimming).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(super) fn frame(
    child: AnyElement,
    _block: &AnswerBlock,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    child
}
