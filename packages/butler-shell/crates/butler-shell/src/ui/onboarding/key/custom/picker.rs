//! `FirstRunModelPicker`: the models a typed server answered with; pick one and start.
use std::rc::Rc;

use butler_ds::ui::blocks::choice_card::ChoiceCardList;
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, Entity, IntoElement as _, ParentElement as _, SharedString};

use super::super::copy::{Words, words};
use super::{CustomServer, Snapshot, connected_notice, model_cards, snapshot};
use crate::ui::onboarding::Onboarding;
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared;
use crate::ui::onboarding::providers::LocalModelOption;

/// Next for the picked model, or on to the reply language once connected.
fn action(
    copy: &Words,
    snap: &Snapshot,
    server: &Entity<CustomServer>,
    api_key: Option<&SharedString>,
    cx: &mut Context<Onboarding>,
) -> SetupWizardStepAction {
    let label = if snap.connecting {
        copy.connecting
    } else {
        copy.next
    };
    let next = SetupWizardStepAction::new("first-run-models-next", label).forward();
    if snap.connected {
        return next.on_click(cx.listener(|view, _, _, cx| view.open_reply(cx)));
    }
    let Some(option) = snap.model.clone() else {
        return next.disabled();
    };
    let (entity, api_key) = (server.clone(), api_key.cloned());
    let next = next.on_click(move |_, _, cx| {
        entity.update(cx, |server, cx| {
            server.pick(option.clone(), api_key.clone(), cx);
        });
    });
    if snap.connecting {
        next.disabled()
    } else {
        next
    }
}

/// `FirstRunModelPicker`: the models of a typed server; pick one and start.
pub(super) fn screen(
    view: &Onboarding,
    server: &Entity<CustomServer>,
    options: &Rc<[LocalModelOption]>,
    api_key: Option<&SharedString>,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let snap = snapshot(view, server, options, cx);
    let next = action(copy, &snap, server, api_key, cx);
    let body = if snap.connected {
        connected_notice(copy, cx)
    } else if options.is_empty() {
        Typo::body(copy.no_models)
            .tone(Tone::Secondary)
            .into_any_element()
    } else {
        let cards = model_cards(options, snap.model.as_ref(), false, server, cx);
        ChoiceCardList::new().children(cards).into_any_element()
    };
    step_card(view, copy.custom_title, [body], cx)
        .content_key("models:other")
        .on_back(
            shared(view.lang).back,
            cx.listener(|view, _, _, cx| view.back_to_list(cx)),
        )
        .footer_start(Typo::caption(copy.local_note).tone(Tone::Tertiary))
        .action(next)
        .into_any_element()
}
