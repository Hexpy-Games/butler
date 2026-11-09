//! `AnswerBlockFrame`, `answerBlockActions` and `AnswerSourceLine`, the one source line every
//! answer family shares.
use butler_ds::ui::blocks::block_action_frame::{BlockActionFrame, Level};
use butler_ds::ui::blocks::overflow_action_menu::OverflowItem;
use butler_ds::ui::clickable::{Clickable, Variant};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, ClipboardItem, ElementId, IntoElement as _, ParentElement as _, SharedString,
};

use super::markdown::to_markdown;
use crate::ui::chat::open_link;
use crate::ui::i18n::media::Media;
use crate::ui::shell::image_viewer::source::{checked_label, site_of};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::AnswerBlock;

/// Wraps a rendered block in its action frame; `path` makes its element id unique.
pub(super) fn frame(
    child: AnyElement,
    block: &AnswerBlock,
    path: &str,
    message: Option<&str>,
    cx: &App,
) -> AnyElement {
    framed(child, block, path, Level::Block, (message, cx))
}

/// `AnswerBlockFrame` with `child`: a block inside a container (a smaller title).
pub(super) fn child_frame(
    child: AnyElement,
    block: &AnswerBlock,
    path: &str,
    message: Option<&str>,
    cx: &App,
) -> AnyElement {
    framed(child, block, path, Level::Child, (message, cx))
}

fn framed(
    child: AnyElement,
    block: &AnswerBlock,
    path: &str,
    level: Level,
    (message, cx): (Option<&str>, &App),
) -> AnyElement {
    let mut frame = BlockActionFrame::new(SharedString::from(format!("answer-frame-{path}")))
        .level(level)
        .actions_label(Media::get(cx).more);
    if let Some(title) = title(block) {
        frame = frame.title(SharedString::from(title.to_owned()));
    }
    for action in actions(block, path, message, cx) {
        frame = frame.action(action);
    }
    frame.child(child).into_any_element()
}

/// `answerBlockActions`: save to the library (a stored message's block), then copy as Markdown.
/// A block without a stored message is a preview and has none. Making a document from a block
/// needs the block as JSON, which the wire types do not write yet.
fn actions(block: &AnswerBlock, path: &str, message: Option<&str>, cx: &App) -> Vec<OverflowItem> {
    let Some(message) = message else {
        return Vec::new();
    };
    let copy = Media::get(cx);
    let mut items = Vec::new();
    // The block's place in the message, as the library route names it.
    if let Some(at) = path.find("/blocks/") {
        let (message, place) = (message.to_owned(), path[at..].to_owned());
        items.push(
            OverflowItem::new(copy.save_to_library)
                .on_select(move |_, cx| save_to_library(&message, &place, cx)),
        );
    }
    let markdown = to_markdown(block);
    let copied = copy.answer_copied;
    items.push(OverflowItem::new(copy.copy).on_select(move |_, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string(markdown.clone()));
        toast::show(cx, Toast::success(copied));
    }));
    items
}

/// `POST /library/blocks`: saves the block as a scrap and says so.
fn save_to_library(message: &str, place: &str, cx: &mut App) {
    let copy = Media::get(cx);
    let body = serde_json::json!({"message_id": message, "path": place});
    let request = Jobs::run(cx, move |client| async move {
        client.save_library_block(&body).await.ok().map(|_| ())
    });
    cx.spawn(async move |cx| {
        let saved = request.await.flatten();
        cx.update(|cx| {
            toast::show(
                cx,
                match saved {
                    Some(()) => Toast::success(copy.saved_to_library),
                    None => Toast::error(copy.action_failed),
                },
            );
        });
    })
    .detach();
}

/// `"title" in block ? block.title : undefined`.
pub(super) fn title(block: &AnswerBlock) -> Option<&str> {
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
        .on_click(move |_, _, cx| open_link(&open, cx))
        .child(Typo::caption(caption).tone(Tone::Tertiary));
    Some(line.into_any_element())
}
