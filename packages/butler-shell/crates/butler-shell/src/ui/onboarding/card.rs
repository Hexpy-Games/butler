//! The step card (`FirstRunStepCard.tsx`): the DS card with the step list (not on a consent
//! renewal), the memory model status on the AI step and the commit-failed notice. Each screen
//! adds its own Back (`on_back(copy.back, ..)`), actions and footer.
use std::rc::Rc;

use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepCard;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};

use super::copy::words;
use super::memory::status::{Retry, memory_status};
use super::readiness::Readiness;
use super::{ConnectView, Onboarding, Step, steps};
use crate::ui::Icon;

/// The card for the current step titled `title`, with `body` before the shared status rows.
pub(crate) fn step_card(
    view: &Onboarding,
    title: impl Into<SharedString>,
    body: impl IntoIterator<Item = AnyElement>,
    cx: &mut Context<Onboarding>,
) -> SetupWizardStepCard {
    let step = view.step(cx);
    let mut card = SetupWizardStepCard::new("first-run-step", title)
        .title_focus(view.title.clone())
        .content_key(step.id());
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
