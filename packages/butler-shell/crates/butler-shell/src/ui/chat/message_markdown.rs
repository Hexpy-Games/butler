// Skeleton (Opus): filled by the C3a markdown writer; see specs/p2-c3a-transcript.md.
//! `MessageMarkdown`, `MarkdownCodeBlock`, `MessageInlineImage`, `inlineImageFiles` on the DS
//! MarkdownContent. Replaces `markdown.rs` and `markdown_view.rs` (deleted at integration).

use gpui::{AnyElement, App, ElementId, IntoElement as _, SharedString, div};

/// `MessageMarkdown`: a message's Markdown. Interface fixed by the skeleton; the body is the
/// markdown writer's.
#[allow(dead_code, reason = "C3a skeleton: wired by the transcript writer")]
pub(crate) fn message_markdown(
    _id: ElementId,
    _text: SharedString,
    _streaming: bool,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}
