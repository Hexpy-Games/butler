//! `confirmAction` (app/confirmation.ts) and `AppConfirmationDialog`: a page asks before an
//! irreversible action; dismissal never accepts, and a new request replaces (declines) the
//! pending one. A typed confirmation (the full reset) keeps Accept off until the phrase matches.
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Layout,
    MaxHeight,
};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::text::Input;
use butler_ds::ui::tooltip::Tooltip;
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

/// `TypedConfirmation`: the phrase to type, the field's label and Accept's tooltip until it
/// matches.
pub(crate) struct Typed {
    pub(crate) phrase: SharedString,
    pub(crate) label: SharedString,
    pub(crate) mismatch: SharedString,
}

/// What the dialog asks (`ConfirmationOptions` and the message).
pub(crate) struct Request {
    message: SharedString,
    title: Option<SharedString>,
    confirm_label: Option<SharedString>,
    destructive: bool,
    details: Vec<Detail>,
    note: Option<SharedString>,
    typed: Option<Typed>,
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
            typed: None,
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

    pub(crate) fn typed(mut self, typed: Typed) -> Self {
        self.typed = Some(typed);
        self
    }
}

type Accept = Box<dyn FnOnce(&mut Window, &mut App)>;

/// A request waiting for the owner, with what runs when it is accepted.
pub(crate) struct Pending {
    pub(super) request: Request,
    /// What the owner typed for a typed confirmation.
    pub(super) typed: String,
    pub(super) on_accept: Accept,
}

impl Pending {
    /// `typedConfirmationMatches`, trimmed (React also NFC-normalizes; the shell has no
    /// Unicode normalization crate).
    fn matched(&self) -> bool {
        self.request
            .typed
            .as_ref()
            .is_none_or(|typed| self.typed.trim() == typed.phrase.trim())
    }
}

fn take(state: &Entity<SettingsState>, cx: &mut App) -> Option<Pending> {
    state.update(cx, |state, cx| {
        cx.notify();
        state.pending_confirm.take()
    })
}

/// The typed phrase's field; each keystroke is kept on the pending request.
fn typed_field(typed: &Typed, value: &str, state: &Entity<SettingsState>) -> AnyElement {
    let state = state.clone();
    Field::new("settings-confirm-typed-field")
        .child(FieldLabel::new().child(typed.label.clone()))
        .child(
            Input::new("settings-confirm-typed")
                .value(value.to_owned())
                .on_change(move |text, _, cx| {
                    state.update(cx, |state, cx| {
                        if let Some(pending) = &mut state.pending_confirm {
                            text.clone_into(&mut pending.typed);
                            cx.notify();
                        }
                    });
                }),
        )
        .into_any_element()
}

/// The details card, the note and the typed phrase: shown only when the request has any.
fn details(pending: &Pending, state: &Entity<SettingsState>) -> Option<AnyElement> {
    let request = &pending.request;
    if request.details.is_empty() && request.typed.is_none() {
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
    let card = (!request.details.is_empty()).then(|| {
        Card::new("settings-confirm-details")
            .padding(CardPadding::Md)
            .child(Stack::new().gap(Space::Sm).children(rows))
    });
    let typed = request
        .typed
        .as_ref()
        .map(|typed| typed_field(typed, &pending.typed, state));
    let gap = if typed.is_some() {
        Space::Md
    } else {
        Space::Sm
    };
    let body = Stack::new()
        .gap(gap)
        .children(card)
        .children(
            request
                .note
                .clone()
                .map(|note| Typo::caption(note).tone(Tone::Secondary)),
        )
        .children(typed);
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
    let matched = pending.matched();
    let mismatch = request.typed.as_ref().map(|typed| typed.mismatch.clone());
    let body = details(pending, state);
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
    let mut accept_button = Button::new("settings-confirm-accept")
        .size(ButtonSize::Sm)
        .variant(if destructive {
            Variant::Destructive
        } else {
            Variant::Default
        })
        .text(label)
        .on_click(move |_, window, cx| {
            let ready = accept
                .read(cx)
                .pending_confirm
                .as_ref()
                .is_some_and(Pending::matched);
            if ready && let Some(pending) = take(&accept, cx) {
                (pending.on_accept)(window, cx);
            }
        });
    if !matched {
        accept_button = accept_button.aria_disabled();
    }
    let accept_control = match mismatch.filter(|_| !matched) {
        Some(mismatch) => Tooltip::new("settings-confirm-mismatch")
            .label(mismatch)
            .child(accept_button)
            .into_any_element(),
        None => accept_button.into_any_element(),
    };
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
        .child(accept_control);
    let dialog = Dialog::new("settings-confirm", window, cx)
        .open(true)
        .on_open_change(move |open, _, cx| {
            if !open {
                take(&dismiss, cx);
            }
        });
    Some(dialog.content(content.footer(footer), window, cx))
}
