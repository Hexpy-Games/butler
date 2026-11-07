//! `AnswerBlockFrame`, `answerBlockActions` and `AnswerSourceLine`, the one source line every
//! answer family shares.
use butler_ds::ui::blocks::block_action_frame::{BlockActionFrame, Level};
use butler_ds::ui::clickable::{Clickable, Variant};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, ElementId, IntoElement as _, ParentElement as _, SharedString};

use crate::ui::shell::image_viewer::source::{checked_label, site_of};
use crate::ui::source::wire::AnswerBlock;

/// Wraps a rendered block in its action frame; `path` makes its element id unique.
pub(super) fn frame(child: AnyElement, block: &AnswerBlock, path: &str) -> AnyElement {
    framed(child, block, path, Level::Block)
}

/// `AnswerBlockFrame` with `child`: a block inside a container (a smaller title).
pub(super) fn child_frame(child: AnyElement, block: &AnswerBlock, path: &str) -> AnyElement {
    framed(child, block, path, Level::Child)
}

fn framed(child: AnyElement, block: &AnswerBlock, path: &str, level: Level) -> AnyElement {
    let mut frame = BlockActionFrame::new(SharedString::from(format!("answer-frame-{path}")))
        .level(level);
    if let Some(title) = title(block) {
        frame = frame.title(SharedString::from(title.to_owned()));
    }
    frame.child(child).into_any_element()
}

/// `"title" in block ? block.title : undefined`.
fn title(block: &AnswerBlock) -> Option<&str> {
    match block {
        AnswerBlock::Cards { title, .. }
        | AnswerBlock::Table { title, .. }
        | AnswerBlock::Gallery { title, .. }
        | AnswerBlock::Facts { title, .. }
        | AnswerBlock::Metrics { title, .. }
        | AnswerBlock::Chart { title, .. }
        | AnswerBlock::Callout { title, .. }
        | AnswerBlock::Actions { title, .. }
        | AnswerBlock::Timeline { title, .. }
        | AnswerBlock::Checklist { title, .. }
        | AnswerBlock::Progress { title, .. }
        | AnswerBlock::Text { title, .. }
        | AnswerBlock::Image { title, .. }
        | AnswerBlock::Quote { title, .. }
        | AnswerBlock::Columns { title, .. }
        | AnswerBlock::Tabs { title, .. }
        | AnswerBlock::Group { title, .. } => title.as_deref(),
        AnswerBlock::Epics { .. } => None,
    }
}

/// `AnswerSourceLine`: the source's site and read date, a text button that opens the page.
/// `source` and `checked` are the item's fields; no source gives no line.
pub(super) fn source_line(
    id: impl Into<ElementId>,
    source: Option<&str>,
    checked: Option<&str>,
) -> Option<AnyElement> {
    let url = source?;
    let site = site_of(url)?;
    let caption = match checked.and_then(checked_label) {
        Some(checked) => format!("{site} · {checked}"),
        None => site,
    };
    let open = url.to_owned();
    let line = Clickable::new(id)
        .variant(Variant::Text)
        .on_click(move |_, _, cx| cx.open_url(&open))
        .child(Typo::caption(caption).tone(Tone::Tertiary));
    Some(line.into_any_element())
}
