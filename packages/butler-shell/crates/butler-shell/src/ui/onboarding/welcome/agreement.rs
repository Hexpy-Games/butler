//! `FirstRunConsent`: the required agreement, in the step card.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::inline_reference::InlineReference;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Window};

use super::copy::words;
use super::start::FIRST_RUN_GUIDE_URL;
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared_words;
use crate::ui::onboarding::readiness::{ReadinessStatus, prep_status};
use crate::ui::onboarding::{Mode, Onboarding};

/// The glyph of each consent item (`ITEM_ICONS`).
const ITEM_ICONS: [Icon; 4] = [
    Icon::GitBranch,
    Icon::Terminal,
    Icon::SendHorizontal,
    Icon::Monitor,
];

/// The consent step.
pub(crate) fn consent_screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let blocked = view.readiness.read(cx).view().status == ReadinessStatus::Failed;
    let saving = view.consent.read(cx).saving();
    let footer = prep_status(view, window, cx);
    let notice = Notice::new(NoticeTone::Warning, copy.consent_clause)
        .icon(icon(Icon::AlertCircle, IconSize::Md, Ds::get(cx)))
        .into_any_element();
    let body = [items(view, cx), notice];

    let mut decline = SetupWizardStepAction::new("first-run-decline", copy.decline)
        .on_click(cx.listener(|view, _, _, cx| view.decline(cx)));
    let mut agree = SetupWizardStepAction::new("first-run-agree", copy.agree)
        .forward()
        .on_click(cx.listener(|view, _, _, cx| {
            let lang = view.lang;
            view.consent
                .update(cx, |consent, cx| consent.agree(lang, cx));
        }));
    if saving {
        decline = decline.disabled();
    }
    if blocked || saving {
        agree = agree.disabled();
    }
    let mut tip = Tooltip::new("first-run-agree-tip");
    if blocked {
        tip = tip.label(copy.agree_blocked);
    }
    let mut card = step_card(view, copy.consent_title, body, cx)
        .footer_start(footer)
        .action(decline)
        .action(tip.child(agree));
    if view.mode != Mode::Consent {
        card = card.on_back(
            shared_words(view.lang).back,
            cx.listener(|view, _, _, cx| view.back_to_welcome(cx)),
        );
    }
    card.into_any_element()
}

/// The four consent items, each with its glyph; the third links to the provider guide.
fn items(view: &Onboarding, cx: &mut Context<Onboarding>) -> AnyElement {
    let copy = words(view.lang);
    let ds = Ds::get(cx);
    let mut list = Stack::new().gap(Space::Sm);
    for (index, (body, caption)) in copy.consent_items.iter().enumerate() {
        if index > 0 {
            list = list.child(Separator::new());
        }
        let mut text = Stack::new().gap(Space::Xs).child(Typo::body(*body));
        if let Some(caption) = caption {
            text = text.child(Typo::caption(*caption).tone(Tone::Secondary));
        }
        if index == 2 {
            text = text.child(
                InlineReference::external(
                    "first-run-consent-guide",
                    format!("{FIRST_RUN_GUIDE_URL}#ai-providers"),
                )
                .label(copy.consent_provider_link),
            );
        }
        let glyph = IconSlot::new().size(SlotSize::Md).min_line().child(icon(
            ITEM_ICONS[index],
            IconSize::Md,
            ds,
        ));
        list = list.child(
            Stack::row()
                .cross(Cross::Start)
                .gap(Space::Md)
                .child(glyph)
                .child(text),
        );
    }
    list.into_any_element()
}
