//! `FirstRunKeyForm`: one API key field, checked on paste; no name field and no Add button.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::field::{Field, FieldError, FieldLabel};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::inline_reference::InlineReference;
use butler_ds::ui::layout::{Cross, Inline, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::text::{self, Input};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, Context, Entity, Focusable as _, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};

use super::copy::{Words, words};
use super::{Failure, KeyForm, Status};
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared;
use crate::ui::onboarding::{Onboarding, providers};

const KEY_FIELD: &str = "first-run-api-key";

pub(crate) fn key_screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let Some(form) = view.key.clone() else {
        return div().into_any_element();
    };
    if form.update(cx, KeyForm::take_focus) {
        text::state(KEY_FIELD, window, cx)
            .read(cx)
            .focus_handle(cx)
            .focus(window, cx);
    }
    let copy = words(view.lang);
    let (card_id, value, typed) = {
        let form = form.read(cx);
        (form.card, form.value.clone(), form.status)
    };
    let spec = providers::card(card_id);
    let (connected, failed) = {
        let commit = view.commit.read(cx);
        (commit.connected().is_some(), commit.failed())
    };
    // `connecting`: the key is saved and the connection is being made.
    let connecting = !connected && !failed && matches!(typed, Status::Valid | Status::Saved);
    let status = if connected {
        Status::Valid
    } else if connecting {
        Status::Checking
    } else {
        typed
    };
    let field = key_field(view.lang, &form, value, status, connected, cx);
    let mut links = Inline::new().gap(Space::Md);
    if let Some(url) = spec.key_url {
        links =
            links.child(InlineReference::external("first-run-key-url", url).label(copy.get_key));
    }
    let links = links
        .child(Typo::caption(copy.key_stored).tone(Tone::Tertiary))
        .into_any_element();
    let name = copy.names[card_id as usize];
    let label = if connecting {
        copy.connecting
    } else {
        copy.next
    };
    let next = SetupWizardStepAction::new("first-run-key-next", label)
        .forward()
        .on_click(cx.listener(|view, _, _, cx| view.open_reply(cx)));
    let next = if connected { next } else { next.disabled() };
    let mut tip = Tooltip::new("first-run-key-next-tip");
    if !connected {
        tip = tip.label(copy.connect_first);
    }
    step_card(view, (copy.key_title)(name), [field, links], cx)
        .content_key(format!("key:{card_id:?}"))
        .description(copy.key_hint)
        .on_back(
            shared(view.lang).back,
            cx.listener(|view, _, _, cx| view.back_to_list(cx)),
        )
        .action(tip.child(next))
        .into_any_element()
}

/// `KeyStatusLine`: the failure with Retry where a second try can help, else the progress.
fn status_line(
    copy: &Words,
    lang: Lang,
    status: Status,
    form: &Entity<KeyForm>,
    cx: &Context<Onboarding>,
) -> AnyElement {
    if let Status::Failed(failure) = status {
        return failure_line(copy, lang, failure, form);
    }
    let done = matches!(status, Status::Valid | Status::Saved);
    let text = match status {
        Status::Checking => copy.checking,
        Status::Valid => copy.key_valid,
        Status::Saved => copy.key_saved,
        _ => copy.key_hint,
    };
    let mut row = Stack::row().cross(Cross::Center).gap(Space::Xs);
    if status == Status::Checking {
        row = row.child(Spinner::new("first-run-key-spinner").size(14.));
    } else if done {
        row = row.child(icon(Icon::CheckIcon, IconSize::Sm, Ds::get(cx)));
    }
    row.child(Typo::caption(text).tone(if done { Tone::Success } else { Tone::Secondary }))
        .into_any_element()
}

fn failure_line(copy: &Words, lang: Lang, failure: Failure, form: &Entity<KeyForm>) -> AnyElement {
    let mut lines = Stack::new()
        .gap(Space::Xs)
        .child(FieldError::new().child(copy.key_errors[failure as usize]));
    if failure.retryable() {
        let form = form.clone();
        lines = lines.child(
            Inline::new().child(
                Button::new("first-run-key-retry")
                    .size(Size::Sm)
                    .variant(Variant::Link)
                    .text(shared(lang).retry)
                    .on_click(move |_, _, cx| form.update(cx, KeyForm::retry)),
            ),
        );
    }
    lines.into_any_element()
}

/// The API key field: masked, invalid on a failure, locked once connected.
fn key_field(
    lang: Lang,
    form: &Entity<KeyForm>,
    value: SharedString,
    status: Status,
    connected: bool,
    cx: &Context<Onboarding>,
) -> AnyElement {
    let copy = words(lang);
    let edit = form.clone();
    let mut input = Input::new(KEY_FIELD)
        .masked()
        .value(value)
        .on_change(move |text, _, cx| edit.update(cx, |form, cx| form.change(text, cx)));
    if matches!(status, Status::Failed(_)) {
        input = input.invalid();
    }
    if connected {
        input = input.disabled();
    }
    Field::new("first-run-key-field")
        .child(FieldLabel::new().child(copy.key_label))
        .child(input)
        .child(status_line(copy, lang, status, form, cx))
        .into_any_element()
}
