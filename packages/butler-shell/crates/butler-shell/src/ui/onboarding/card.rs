//! The step card (`FirstRunStepCard.tsx`): the DS card with the step list (not on a consent
//! renewal), the memory model status on the AI step and the commit-failed notice; its title takes
//! the focus when the content changes. Each screen adds its own Back (`on_back(copy.back, ..)`),
//! actions and footer.
use std::rc::Rc;

use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepCard;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{
    AnyElement, App, Context, FocusHandle, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

use super::copy::words;
use super::memory::status::{Retry, memory_status};
use super::readiness::Readiness;
use super::{ConnectView, Onboarding, Step, steps};
use crate::ui::Icon;

/// The card for the current step titled `title`, its content keyed `key` (`contentKey`), with
/// `body` before the shared status rows.
pub(crate) fn step_card(
    view: &Onboarding,
    key: impl Into<SharedString>,
    title: impl Into<SharedString>,
    body: impl IntoIterator<Item = AnyElement>,
    cx: &mut Context<Onboarding>,
) -> SetupWizardStepCard {
    let step = view.step(cx);
    let key = key.into();
    let mut card = SetupWizardStepCard::new("first-run-step", title)
        .title_focus(view.title.clone())
        .content_key(key.clone())
        .child(TitleFocus {
            title: view.title.clone(),
            key,
        });
    if let Some(progress) = steps::progress(view, cx) {
        card = card.progress(progress);
    }
    card = card.children(body);
    if step == Step::Connect {
        let model = view.readiness.read(cx).view().memory_model.clone();
        let readiness = view.readiness.clone();
        let retry: Retry = Rc::new(move |_, cx| readiness.update(cx, Readiness::retry));
        card = card.children(memory_status(model.as_ref(), view.lang, retry));
    }
    if view.commit.read(cx).failed() && !matches!(view.stages.view, ConnectView::SignIn) {
        card = card.child(finish_failed(view, cx));
    }
    card
}

/// `FirstRunStepCard`'s effect: the title takes the focus on mount and whenever the content key
/// changes, so no field shows a ring when a card opens. It runs where the card draws, after the
/// heading tracks the handle; out of the flow, it adds no gap.
#[derive(IntoElement)]
struct TitleFocus {
    title: FocusHandle,
    key: SharedString,
}

impl RenderOnce for TitleFocus {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let shown = window.use_keyed_state("first-run-title-key", cx, |_, _| None::<SharedString>);
        if shown.read(cx).as_ref() != Some(&self.key) {
            shown.update(cx, |shown, _| *shown = Some(self.key));
            self.title.focus(window, cx);
        }
        div().absolute()
    }
}

/// The commit failed: the notice with Retry.
fn finish_failed(view: &Onboarding, cx: &mut Context<Onboarding>) -> AnyElement {
    let copy = words(view.lang);
    let retry = Button::new("first-run-commit-retry")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.retry)
        .on_click(cx.listener(|view, _, _, cx| view.retry_commit(cx)));
    Notice::new(NoticeTone::Error, copy.finish_failed)
        .icon(icon(Icon::CircleAlert, IconSize::Md, Ds::get(cx)))
        .action(retry)
        .into_any_element()
}
