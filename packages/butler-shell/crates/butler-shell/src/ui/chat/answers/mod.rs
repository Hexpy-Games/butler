//! The 18 answer-block types (React `AnswerBlocks.tsx` switch).
mod cards;
mod containers;
mod data;
mod frame;
mod leaf;
mod markdown;

use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    Window, div,
};

use super::TranscriptCtx;
use crate::ui::source::wire::{AnswerBlock, AnswerBlockSet};

/// `AnswerBlocks`: a message's answer-block sets; nothing when they hold no block. A block's
/// path is its set's call id and its place in the message (`/blocks/{index}`, the place the
/// library route names), so its element ids and card state are its own.
pub(crate) fn answer_blocks(
    sets: &[AnswerBlockSet],
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let mut stack = Stack::new().gap(Space::Md);
    let mut shown = false;
    let blocks = sets.iter().flat_map(|set| {
        set.spec
            .blocks
            .iter()
            .map(move |entry| (set.call_id.as_str(), entry))
    });
    for (index, (call_id, entry)) in blocks.enumerate() {
        let path = format!("{call_id}/blocks/{index}");
        let rendered = block(entry, &path, t, window, cx);
        let id = SharedString::from(format!("answer-block-{path}"));
        stack = stack.child(div().id(id).child(rendered));
        shown = true;
    }
    shown.then(|| stack.into_any_element())
}

/// One block: dispatches to its family and wraps it in the frame. Containers call it for
/// their children.
pub(super) fn block(
    block: &AnswerBlock,
    path: &str,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = body(block, path, t, window, cx);
    frame::frame(body, block, path, t, cx)
}

/// A block inside a container: the same family render in the frame's child level.
pub(super) fn child_block(
    block: &AnswerBlock,
    path: &str,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = body(block, path, t, window, cx);
    frame::child_frame(body, block, path, t, cx)
}

/// The family render of one block (the `Block` switch of `AnswerBlocks.tsx`).
fn body(
    block: &AnswerBlock,
    path: &str,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match block {
        AnswerBlock::Columns { .. } | AnswerBlock::Tabs { .. } | AnswerBlock::Group { .. } => {
            containers::render(block, path, t, window, cx)
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
        | AnswerBlock::Actions { .. } => leaf::render(block, path, cx),
        AnswerBlock::Cards { .. } | AnswerBlock::Epics { .. } => cards::render(block, path),
        AnswerBlock::Table { .. } | AnswerBlock::Gallery { .. } | AnswerBlock::Chart { .. } => {
            data::render(block, path, window, cx)
        }
    }
}
