//! `AnswerBlockFrame`, `answerBlockActions`, `AnswerItem`, `AnswerSourceLine`.
use butler_ds::ui::blocks::block_action_frame::{BlockActionFrame, Level};
use butler_ds::ui::clickable::{Clickable, Variant};
use butler_ds::ui::typo::{Tone, Typo};
use chrono::DateTime;
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::AnswerBlock;

/// `AnswerItem`'s superseded opacity (`animateMotion` hold at 0.45).
const SUPERSEDED_OPACITY: f32 = 0.45;

/// Wraps a rendered block in its action frame (save to library, superseded dimming).
pub(super) fn frame(
    child: AnyElement,
    block: &AnswerBlock,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    framed(child, block, Level::Block)
}

/// `AnswerBlockFrame` with `child`: a block inside a container (a smaller title).
pub(super) fn child_frame(
    child: AnyElement,
    block: &AnswerBlock,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    framed(child, block, Level::Child)
}

fn framed(child: AnyElement, block: &AnswerBlock, level: Level) -> AnyElement {
    let mut frame = BlockActionFrame::new("answer-frame").level(level);
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

/// `AnswerItem`: one item of a block; an item the retry has not replaced yet is dimmed.
#[allow(
    dead_code,
    reason = "P2 shell-wave: called by the family units (leaf, cards, data)"
)]
pub(super) fn item(child: AnyElement, superseded: bool) -> AnyElement {
    let item = div().child(child);
    if superseded {
        item.opacity(SUPERSEDED_OPACITY).into_any_element()
    } else {
        item.into_any_element()
    }
}

/// `AnswerSourceLine`: the source's site and read date, a text button that opens the page.
/// `source` and `checked` are the item's fields; no source gives no line.
#[allow(
    dead_code,
    reason = "P2 shell-wave: called by the family units (leaf, cards, data)"
)]
pub(super) fn source_line(
    id: impl Into<ElementId>,
    source: Option<&str>,
    checked: Option<&str>,
) -> Option<AnyElement> {
    let url = source?;
    let site = site_of(url)?;
    let caption = match checked_label(checked) {
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

/// `new URL(url).hostname` without a leading `www.`.
fn site_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(host.strip_prefix("www.").unwrap_or(host).to_owned())
}

/// `checkedLabel`: the read date of the source line.
fn checked_label(checked: Option<&str>) -> Option<String> {
    let date = DateTime::parse_from_rfc3339(checked?).ok()?;
    Some(date.format("%Y-%m-%d").to_string())
}
