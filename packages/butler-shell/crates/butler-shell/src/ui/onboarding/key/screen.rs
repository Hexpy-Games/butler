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
    AnyElement, App, Context, Entity, Focusable as _, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

use super::copy::{Words, words};
use super::{Failure, KeyForm, Status};
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared;
use crate::ui::onboarding::{Onboarding, providers};

const KEY_FIELD: &str = "first-run-api-key";

pub(crate) fn key_screen(
    view: &Onboarding,
    _window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let Some(form) = view.key.clone() else {
        return div().into_any_element();
    };
    let focus = form.update(cx, KeyForm::take_focus);
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
    let field = key_field(view.lang, &form, value, focus, status, connected, cx);
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
    step_card(
        view,
        format!("key:{card_id:?}"),
        (copy.key_title)(name),
        [field, links],
        cx,
    )
    .description(copy.key_hint)
    .on_back(
        shared(view.lang).back,
        cx.listener(|view, _, _, cx| view.back_to_list(cx)),
    )
    .action(
        crate::ui::widgets::control_anchor(div().flex(), "first-run-key-next", connected)
            .child(tip.child(next)),
    )
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

/// The field takes the focus when asked (after a failed check). Its state is keyed where the input
/// renders, so the input renders here first and the lookup follows at the same place; a
/// lookup in the screen's render (or before this render) reaches a different, never drawn
/// state.
#[derive(IntoElement)]
struct AutoFocus {
    input: Input,
    focus: bool,
}

impl RenderOnce for AutoFocus {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let input = self.input.render(window, cx).into_any_element();
        if self.focus {
            text::state(KEY_FIELD, window, cx)
                .read(cx)
                .focus_handle(cx)
                .focus(window, cx);
        }
        input
    }
}

/// The API key field: masked, invalid on a failure, locked once connected; `focus` after a failure.
fn key_field(
    lang: Lang,
    form: &Entity<KeyForm>,
    value: SharedString,
    focus: bool,
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
    crate::ui::widgets::anchor(div().flex().flex_col(), "first-run-key-field")
        .child(
            Field::new("first-run-key-field")
                .child(FieldLabel::new().child(copy.key_label))
                .child(
                    crate::ui::widgets::anchor(div().flex().flex_col(), KEY_FIELD)
                        .child(AutoFocus { input, focus }),
                )
                .child(status_line(copy, lang, status, form, cx)),
        )
        .into_any_element()
}
