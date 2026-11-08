//! `confirmAction` (app/confirmation.ts) and `AppConfirmationDialog`: a page asks before an
//! irreversible action; dismissal never accepts, and a new request replaces (declines) the
//! pending one. Typed confirmation only serves the full reset, which is carved out.
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Layout,
    MaxHeight,
};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::state::SettingsState;
use crate::ui::i18n::settings::words;

/// A detail row of the request (`details[]`).
pub(crate) struct Detail {
    pub(crate) label: Option<SharedString>,
    pub(crate) text: SharedString,
    pub(crate) caption: Option<SharedString>,
}

/// What the dialog asks (`ConfirmationOptions` and the message).
pub(crate) struct Request {
    message: SharedString,
    title: Option<SharedString>,
    confirm_label: Option<SharedString>,
    destructive: bool,
    details: Vec<Detail>,
    note: Option<SharedString>,
}

impl Request {
    pub(crate) fn new(message: impl Into<SharedString>) -> Self {
        Self {
            message: message.into(),
            title: None,
            confirm_label: None,
            destructive: false,
            details: Vec::new(),
            note: None,
        }
    }

    pub(crate) fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub(crate) fn confirm_label(mut self, label: impl Into<SharedString>) -> Self {
        self.confirm_label = Some(label.into());
        self
    }

    pub(crate) fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    pub(crate) fn detail(mut self, detail: Detail) -> Self {
        self.details.push(detail);
        self
    }

    pub(crate) fn note(mut self, note: impl Into<SharedString>) -> Self {
        self.note = Some(note.into());
        self
    }
}

type Accept = Box<dyn FnOnce(&mut Window, &mut App)>;

/// A request waiting for the owner, with what runs when it is accepted.
pub(crate) struct Pending {
    pub(super) request: Request,
    pub(super) on_accept: Accept,
}

fn take(state: &Entity<SettingsState>, cx: &mut App) -> Option<Pending> {
    state.update(cx, |state, cx| {
        cx.notify();
        state.pending_confirm.take()
    })
}

/// The details card, the note: shown only when the request has details.
fn details(request: &Request) -> Option<AnyElement> {
    if request.details.is_empty() {
        return None;
    }
    let rows = request.details.iter().map(|detail| {
        Stack::new()
            .gap(Space::None)
            .children(
                detail
                    .label
                    .clone()
                    .map(|label| Typo::caption(label).tone(Tone::Secondary)),
            )
            .child(Typo::body(detail.text.clone()).wrap(Wrap::Pre).literal())
            .children(detail.caption.clone().map(|caption| {
                Typo::caption(caption)
                    .tone(Tone::Secondary)
                    .wrap(Wrap::Anywhere)
            }))
    });
    let card = Card::new("settings-confirm-details")
        .padding(CardPadding::Md)
        .child(Stack::new().gap(Space::Sm).children(rows));
    let body = Stack::new().gap(Space::Sm).child(card).children(
        request
            .note
            .clone()
            .map(|note| Typo::caption(note).tone(Tone::Secondary)),
    );
    Some(
        ScrollArea::new("settings-confirm-scroll")
            .fill()
            .child(body)
            .into_any_element(),
    )
}

/// The pending request's dialog, while there is one.
pub(super) fn dialog(
    state: &Entity<SettingsState>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let pending = state.read(cx).pending_confirm.as_ref()?;
    let request = &pending.request;
    let copy = words(Ds::get(cx).lang());
    let title = request.title.clone().unwrap_or_else(|| copy.confirm.into());
    let label = request
        .confirm_label
        .clone()
        .unwrap_or_else(|| copy.confirm.into());
    let destructive = request.destructive;
    let body = details(request);
    let mut content = DialogContent::new().show_close_button(false).header(
        DialogHeader::new()
            .child(DialogTitle::new(title))
            .child(DialogDescription::new(request.message.clone())),
    );
    if let Some(body) = body {
        content = content
            .layout(Layout::ScrollBody)
            .max_height(MaxHeight::ThreeFifths)
            .child(body);
    }
    let (dismiss, cancel, accept) = (state.clone(), state.clone(), state.clone());
    let footer = DialogFooter::new()
        .child(
            Button::new("settings-confirm-cancel")
                .size(ButtonSize::Sm)
                .variant(Variant::Ghost)
                .text(copy.cancel)
                .on_click(move |_, _, cx| {
                    take(&cancel, cx);
                }),
        )
        .child(
            Button::new("settings-confirm-accept")
                .size(ButtonSize::Sm)
                .variant(if destructive {
                    Variant::Destructive
                } else {
                    Variant::Default
                })
                .text(label)
                .on_click(move |_, window, cx| {
                    if let Some(pending) = take(&accept, cx) {
                        (pending.on_accept)(window, cx);
                    }
                }),
        );
    let dialog = Dialog::new("settings-confirm", window, cx)
        .open(true)
        .on_open_change(move |open, _, cx| {
            if !open {
                take(&dismiss, cx);
            }
        });
    Some(dialog.content(content.footer(footer), window, cx))
}
