//! The 18 answer-block types (React `AnswerBlocks.tsx` switch).
mod cards;
mod containers;
mod data;
mod frame;
mod leaf;

use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, Window, div,
};

use super::TranscriptCtx;
use crate::ui::source::wire::{AnswerBlock, AnswerBlockSet};

/// `AnswerBlocks`: a message's answer-block sets.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn answer_blocks(
    sets: &[AnswerBlockSet],
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut stack = Stack::new().gap(Space::Md);
    let blocks = sets.iter().flat_map(|set| set.spec.blocks.iter());
    for (index, entry) in blocks.enumerate() {
        let rendered = block(entry, t, window, cx);
        stack = stack.child(div().id(("answer-block", index)).child(rendered));
    }
    stack.into_any_element()
}

/// One block: dispatches to its family and wraps it in the frame. Containers call it for
/// their children.
pub(super) fn block(
    block: &AnswerBlock,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = body(block, t, window, cx);
    frame::frame(body, block, t, window, cx)
}

/// A block inside a container: the same family render in the frame's child level.
pub(super) fn child_block(
    block: &AnswerBlock,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = body(block, t, window, cx);
    frame::child_frame(body, block, t, window, cx)
}

/// The family render of one block (the `Block` switch of `AnswerBlocks.tsx`).
fn body(block: &AnswerBlock, t: &TranscriptCtx, window: &mut Window, cx: &mut App) -> AnyElement {
    match block {
        AnswerBlock::Columns { .. } | AnswerBlock::Tabs { .. } | AnswerBlock::Group { .. } => {
            containers::render(block, t, window, cx)
        }
        AnswerBlock::Timeline { .. }
        | AnswerBlock::Checklist { .. }
        | AnswerBlock::Progress { .. }
        | AnswerBlock::Text { .. }
        | AnswerBlock::Image { .. }
        | AnswerBlock::Quote { .. }
        | AnswerBlock::Facts { .. }
        | AnswerBlock::Metrics { .. }
        | AnswerBlock::Callout { .. }
        | AnswerBlock::Actions { .. } => leaf::render(block, t, window, cx),
        AnswerBlock::Cards { .. } | AnswerBlock::Epics { .. } => {
            cards::render(block, t, window, cx)
        }
        AnswerBlock::Table { .. } | AnswerBlock::Gallery { .. } | AnswerBlock::Chart { .. } => {
            data::render(block, t, window, cx)
        }
    }
}
