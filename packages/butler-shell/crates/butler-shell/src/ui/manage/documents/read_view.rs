//! `DocumentReadView`: the body, read-only. Markdown goes to the DS MarkdownContent; a `blocks`
//! fence is an answer-block spec.
use gpui::ParentElement as _;
use std::collections::HashMap;

use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, ImageSource, IntoElement as _, SharedString};
use serde_json::Value;

use super::api::Doc;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};

/// A part of the body: Markdown, or a valid `blocks` fence (the fence text, markers included).
pub(super) enum Segment<'a> {
    Markdown(&'a str),
    Blocks(&'a str),
}

/// An open code fence.
struct Open {
    marker: u8,
    len: usize,
    /// Where its opening line starts, and where its content does.
    start: usize,
    content: usize,
    blocks: bool,
}

/// A fence line (`` ``` `` or `~~~`, up to three spaces of indent): its marker, its length and
/// its info string.
fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let text = line.trim_end_matches(['\n', '\r']);
    let rest = text.trim_start_matches(' ');
    if text.len() - rest.len() > 3 {
        return None;
    }
    let marker = *rest.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let len = rest.bytes().take_while(|c| *c == marker).count();
    let info = rest[len..].trim();
    (len >= 3 && !(marker == b'`' && info.contains('`'))).then_some((marker, len, info))
}

/// `JSON.parse(node.value)` then `spec.blocks.map(..)`: anything else stays a visible fence.
fn spec(content: &str) -> bool {
    serde_json::from_str::<Value>(content).is_ok_and(|spec| spec["blocks"].is_array())
}

/// Closes the Markdown before `start`, then the `blocks` fence `start..end`.
fn take<'a>(
    body: &'a str,
    parts: &mut Vec<Segment<'a>>,
    kept: &mut usize,
    start: usize,
    end: usize,
) {
    if *kept < start {
        parts.push(Segment::Markdown(&body[*kept..start]));
    }
    parts.push(Segment::Blocks(&body[start..end]));
    *kept = end;
}

/// The top-level `blocks` fences (`node.type === "code" && node.lang === "blocks"`) and the
/// Markdown between them. The parts join back into `body` byte for byte.
pub(super) fn split(body: &str) -> Vec<Segment<'_>> {
    let mut parts = Vec::new();
    let (mut kept, mut at) = (0, 0);
    let mut open: Option<Open> = None;
    for line in body.split_inclusive('\n') {
        let end = at + line.len();
        if let Some((marker, len, info)) = fence(line) {
            let closes = open
                .as_ref()
                .is_some_and(|o| o.marker == marker && len >= o.len && info.is_empty());
            if closes && let Some(done) = open.take() {
                if done.blocks && spec(&body[done.content..at]) {
                    take(body, &mut parts, &mut kept, done.start, end);
                }
            } else if open.is_none() {
                open = Some(Open {
                    marker,
                    len,
                    start: at,
                    content: end,
                    blocks: line.starts_with(['`', '~'])
                        && info.split_whitespace().next() == Some("blocks"),
                });
            }
        }
        at = end;
    }
    // A fence the body never closes runs to its end.
    if let Some(done) = open
        && done.blocks
        && spec(&body[done.content..])
    {
        take(body, &mut parts, &mut kept, done.start, body.len());
    }
    if kept < body.len() {
        parts.push(Segment::Markdown(&body[kept..]));
    }
    parts
}

/// The body of `doc`: one Markdown run or fence after another.
pub(super) fn read_view(doc: &Doc, cx: &mut App) -> AnyElement {
    let mut stack = Stack::new().gap(Space::Md);
    for (index, part) in split(&doc.body).into_iter().enumerate() {
        let id = SharedString::from(format!("document-read-{index}"));
        stack = match part {
            Segment::Markdown(text) => {
                let ready = pictures(doc, text, cx);
                stack.child(
                    MarkdownContent::new(id, text.to_owned())
                        .image_source(move |src| ready.get(src).cloned()),
                )
            }
            // CARVE-OUT(G-ds): the answer-block renderer (`chat::answers::answer_blocks`) needs a
            // transcript context; React's `AnswerBlocks preview` has none. Until the frame
            // exposes a context-free entry, the fence shows as the code it is.
            Segment::Blocks(fence) => stack.child(MarkdownContent::new(id, fence.to_owned())),
        };
    }
    stack.into_any_element()
}

/// The loaded pictures of the document assets `text` names, by the image's `src` (the asset
/// id); starts the load of each one not yet asked for.
fn pictures(doc: &Doc, text: &str, cx: &mut App) -> HashMap<String, ImageSource> {
    doc.assets
        .iter()
        .filter(|asset| text.contains(&asset.id))
        .filter_map(|asset| {
            let image = picture(&PictureId::Asset(asset.id.clone()), cx)?;
            Some((asset.id.clone(), ImageSource::Image(image)))
        })
        .collect()
}
