//! The suggest-a-change dialog: from an authority card the owner writes how Butler should do it
//! instead, and the request is answered with that instruction (the client's `modify`). A DS
//! Dialog: it holds the exact action and one instruction field, and scrolls inside the window.
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::dialog::{Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Size};
use butler_ds::ui::text::{self, Textarea};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use super::request::Line;
use super::visible::{approval_line, visible_code};
use super::{Handles, Verdict};
use crate::ui::i18n::authority::Authority;

/// The gateway accepts instructions up to 16 KB.
const MAX_INSTRUCTION: usize = 16 * 1024;

pub(super) struct Modify<'a> {
    pub(super) open: Entity<bool>,
    pub(super) copy: Authority,
    pub(super) title: &'a str,
    pub(super) details: &'a [Line],
    pub(super) handles: Handles,
}

/// The exact action (the card's title and detail lines), as the card shows it.
fn action(title: &str, details: &[Line]) -> AnyElement {
    let lines = details.iter().map(|line| match line {
        Line::Text(text) => Typo::caption(approval_line(text))
            .tone(Tone::Secondary)
            .wrap(Wrap::Anywhere)
            .literal()
            .into_any_element(),
        Line::Code(code) => Typo::code(visible_code(code))
            .tone(Tone::Secondary)
            .wrap(Wrap::Anywhere)
            .literal()
            .into_any_element(),
    });
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .child(
            Typo::label(approval_line(title))
                .wrap(Wrap::Anywhere)
                .literal(),
        )
        .children(lines)
        .into_any_element()
}

pub(super) fn dialog(m: Modify<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let is_open = *m.open.read(cx);
    let state = m.open.clone();
    let dialog = Dialog::new("authority-modify-dialog", window, cx)
        .open(is_open)
        .on_open_change(move |open, _, cx| {
            state.update(cx, |state, cx| {
                *state = open;
                cx.notify();
            });
        });
    // One field per request, so a draft never lands on another request.
    let input = SharedString::from(format!("authority-modify-input-{}", m.handles.key));
    let input_id = input.clone();
    let (submit_dialog, handles) = (dialog.clone(), m.handles);
    let submit = Button::new("authority-modify-submit")
        .text(m.copy.submit_modify())
        .on_click(move |_, window, cx| {
            let instruction = text::state(input.clone(), window, cx)
                .read(cx)
                .as_str()
                .trim()
                .to_owned();
            if instruction.is_empty() || instruction.len() > MAX_INSTRUCTION {
                return;
            }
            // A refused decision (one is pending) keeps the dialog and the text.
            if handles.decide(Verdict::Modify(instruction), cx) {
                text::state(input.clone(), window, cx)
                    .update(cx, |field, cx| field.emplace("", cx));
                submit_dialog.set_open(false, window, cx);
            }
        });
    let content = DialogContent::new()
        .size(Size::Md)
        .header(DialogHeader::new().child(DialogTitle::new(m.copy.modify())))
        .child(action(m.title, m.details))
        .child(
            Textarea::new(input_id)
                .probe("authority-modify-input")
                .placeholder(m.copy.modify_placeholder())
                .rows(3),
        )
        .footer(
            DialogFooter::new()
                .child(
                    Button::new("authority-modify-cancel")
                        .variant(Variant::Outline)
                        .text(m.copy.cancel())
                        .on_click(dialog.closer().on_click()),
                )
                .child(submit),
        );
    dialog.content(content, window, cx)
}
