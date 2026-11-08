//! `FirstRunPrepStatus` and `PreparationLine`: the quiet preparation line, and on a failure the
//! notice with Try again and the More menu.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::copy::words;
use super::{Readiness, ReadinessStatus, ReadinessView, report};
use crate::ui::onboarding::Onboarding;
use crate::ui::onboarding::copy::words as shared_words;
use crate::ui::onboarding::memory::status::{Retry, memory_status};

/// `FirstRunPrepStatus`: the line, and the memory model download under it.
pub(crate) fn prep_status(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let line = preparation_line(view, window, cx);
    let model = view.readiness.read(cx).view().memory_model.clone();
    let readiness = view.readiness.clone();
    let retry: Retry = Rc::new(move |_, cx| readiness.update(cx, Readiness::retry));
    Stack::new()
        .gap(Space::Sm)
        .child(line)
        .children(memory_status(model.as_ref(), view.lang, retry))
        .into_any_element()
}

/// `PreparationLine`: working with its step count, ready, or the failure notice.
pub(crate) fn preparation_line(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let state = view.readiness.read(cx).view().clone();
    let copy = words(view.lang);
    let ds = Ds::get(cx);
    let slot = |glyph: AnyElement| IconSlot::new().size(SlotSize::Sm).min_line().child(glyph);
    match state.status {
        ReadinessStatus::Failed => failure(view, &state, window, cx),
        ReadinessStatus::Ready => Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Start)
            .child(slot(
                icon(Icon::CheckIcon, IconSize::Sm, ds).into_any_element(),
            ))
            .child(Typo::caption(copy.ready).tone(Tone::Success))
            .into_any_element(),
        ReadinessStatus::Preparing => {
            let progress = if state.total > 0 {
                format!("{} · {}/{}", copy.working, state.done, state.total)
            } else {
                copy.working.to_owned()
            };
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Start)
                .child(slot(
                    Spinner::new("first-run-prep-spinner")
                        .size(14.)
                        .into_any_element(),
                ))
                .child(Typo::caption(progress).tone(Tone::Secondary).tabular())
                .into_any_element()
        }
    }
}

/// `FirstRunPrepFailure`.
fn failure(
    view: &Onboarding,
    state: &ReadinessView,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let reason = copy.reason(state.error_code.as_deref().unwrap_or("default"));
    let readiness = view.readiness.clone();
    let retry = Button::new("first-run-prep-retry")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(shared_words(view.lang).retry)
        .on_click(move |_, _, cx| readiness.update(cx, Readiness::retry));
    let actions = button::container(Size::Sm)
        .child(retry)
        .child(more_menu(view, window, cx));
    Notice::new(NoticeTone::Error, reason)
        .title(copy.failed)
        .icon(icon(Icon::AlertCircle, IconSize::Md, Ds::get(cx)))
        .action(actions)
        .into_any_element()
}

/// The More menu: Reset and restart, Copy info for a bug report, Quit.
fn more_menu(view: &Onboarding, window: &mut Window, cx: &mut Context<Onboarding>) -> AnyElement {
    let copy = words(view.lang);
    let lang = view.lang;
    let (repair, readiness) = (view.readiness.clone(), view.readiness.clone());
    let menu = DropdownMenu::new("first-run-prep-more", window, cx);
    let content = DropdownMenuContent::new()
        .align(Align::End)
        .child(Item::new(copy.repair).on_select(move |_, cx| repair.update(cx, Readiness::repair)))
        .child(Item::new(copy.copy_report).on_select(move |_, cx| {
            let state = readiness.read(cx).view().clone();
            report::copy(&state, lang, cx);
        }))
        .child(Item::new(copy.quit).on_select(|_, cx| crate::lifecycle::quit(cx)));
    let trigger = menu.trigger(|toggle| {
        Button::new("first-run-prep-more-trigger")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(copy.more)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = menu.content(content, window, cx);
    div()
        .flex()
        .child(trigger)
        .child(content)
        .into_any_element()
}
