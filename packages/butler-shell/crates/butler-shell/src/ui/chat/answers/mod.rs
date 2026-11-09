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
use crate::ui::source::wire::{AnswerBlock, AnswerBlockSet, AnswerBlocks};

/// `AnswerBlocks`: a message's answer-block sets; nothing when they hold no block. A block's
/// path is its set's call id and its place in the message (`/blocks/{index}`, the place the
/// library route names), so its element ids and card state are its own.
pub(crate) fn answer_blocks(
    sets: &[AnswerBlockSet],
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let blocks = sets.iter().flat_map(|set| {
        set.spec
            .blocks
            .iter()
            .map(move |entry| (set.call_id.as_str(), entry))
    });
    stacked(blocks, t.message_id, window, cx)
}

/// `AnswerBlocks preview`: one spec read-only, with no message behind it (a document's `blocks`
/// fence), so its frames carry no actions. `call_id` keeps its element ids apart from the
/// other fences of the page.
pub(crate) fn preview_blocks(
    call_id: &str,
    spec: &AnswerBlocks,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let blocks = spec.blocks.iter().map(|entry| (call_id, entry));
    stacked(blocks, None, window, cx).unwrap_or_else(|| div().into_any_element())
}

/// `toMarkdown` of a spec; `images` writes an image block's asset as a URL.
pub(crate) fn spec_markdown(
    spec: &AnswerBlocks,
    images: &dyn Fn(&str) -> Option<String>,
) -> String {
    markdown::spec_markdown(&spec.blocks, images)
}

/// The blocks (each with its set's call id) one under another; nothing when there are none.
fn stacked<'a>(
    blocks: impl Iterator<Item = (&'a str, &'a AnswerBlock)>,
    message: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let mut stack = Stack::new().gap(Space::Md);
    let mut shown = false;
    for (index, (call_id, entry)) in blocks.enumerate() {
        let path = format!("{call_id}/blocks/{index}");
        let rendered = block(entry, &path, message, window, cx);
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
    message: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = body(block, path, message, window, cx);
    frame::frame(body, block, path, message, cx)
}

/// A block inside a container: the same family render in the frame's child level.
pub(super) fn child_block(
    block: &AnswerBlock,
    path: &str,
    message: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = body(block, path, message, window, cx);
    frame::child_frame(body, block, path, message, cx)
}

/// The family render of one block (the `Block` switch of `AnswerBlocks.tsx`).
fn body(
    block: &AnswerBlock,
    path: &str,
    message: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match block {
        AnswerBlock::Columns { .. } | AnswerBlock::Tabs { .. } | AnswerBlock::Group { .. } => {
            containers::render(block, path, message, window, cx)
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
