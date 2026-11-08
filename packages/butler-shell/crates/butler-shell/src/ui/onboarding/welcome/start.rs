//! `FirstRunWelcome`: the introduction, the interface language and the start action.
use butler_ds::ui::blocks::setup_wizard_shell::{
    SetupWizardContent, SetupWizardMark, SetupWizardVariant,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::inline_reference::InlineReference;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{TextAlign, Tone, Typo};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Window};

use super::copy::words;
use super::language_code;
use crate::ui::onboarding::readiness::{ReadinessStatus, prep_status, preparation_line};
use crate::ui::onboarding::{Mode, Onboarding};

/// Opens the Butler user manual's first-run page in the user's browser.
pub(super) const FIRST_RUN_GUIDE_URL: &str =
    "https://butler.hexpy.games/help/getting-started/first-run/";

/// The welcome step.
pub(crate) fn screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let blocked = view.readiness.read(cx).view().status == ReadinessStatus::Failed;
    let saving = view.consent.read(cx).saving();
    let intro = Stack::new()
        .cross(Cross::Center)
        .gap(Space::Md)
        .child(SetupWizardMark::new("first-run-mark"))
        .child(Typo::h3(copy.welcome_title).align(TextAlign::Center))
        .child(
            Typo::body(copy.welcome_lede)
                .tone(Tone::Secondary)
                .align(TextAlign::Center),
        );
    SetupWizardContent::new()
        .variant(SetupWizardVariant::Focus)
        .solid()
        .child(intro)
        .child(language_field(view, cx))
        .child(rows(view, blocked, saving, window, cx))
        .into_any_element()
}

/// The interface language: the whole onboarding and the app's copy follow it.
fn language_field(view: &Onboarding, cx: &mut Context<Onboarding>) -> AnyElement {
    let onboarding = cx.entity();
    let select = NativeSelect::new("first-run-language")
        .size(SelectSize::Sm)
        .stretch()
        .value(language_code(view.lang))
        .option("ko", "한국어")
        .option("en", "English")
        .on_change(move |value, _, cx| {
            let lang = if value == "ko" { Lang::Ko } else { Lang::En };
            onboarding.update(cx, |view, cx| view.set_lang(lang, cx));
        });
    Field::new("first-run-language")
        .child(FieldLabel::new().child(words(view.lang).interface_language))
        .child(select)
        .into_any_element()
}

/// The start button (and Cancel on a rerun), then the status row.
fn rows(
    view: &Onboarding,
    blocked: bool,
    saving: bool,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    // CARVE-OUT(G-start-focus): React focuses the start button when the flow comes back to
    // welcome (`focusStart`); the DS Button has no focus handle to take.
    let mut start = Button::new("first-run-start")
        .size(Size::Lg)
        .stretch()
        .text(copy.start)
        .on_click(cx.listener(|view, _, _, cx| view.start(cx)));
    if blocked || saving {
        start = start.disabled();
    }
    let mut tip = Tooltip::new("first-run-start-tip").fill();
    if blocked {
        tip = tip.label(copy.agree_blocked);
    }
    let mut buttons = Stack::new()
        .gap(Space::Md)
        .cross(Cross::Stretch)
        .child(tip.child(start));
    if view.mode == Mode::Rerun {
        buttons = buttons.child(
            Button::new("first-run-cancel")
                .size(Size::Lg)
                .variant(Variant::Ghost)
                .stretch()
                .text(copy.cancel)
                .on_click(cx.listener(|view, _, _, cx| view.cancel(cx))),
        );
    }
    let status = if blocked {
        prep_status(view, window, cx)
    } else {
        Stack::row()
            .justify(Justify::Center)
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(preparation_line(view, window, cx))
            .child(Typo::caption("·").tone(Tone::Tertiary))
            .child(
                InlineReference::external("first-run-guide", FIRST_RUN_GUIDE_URL)
                    .label(copy.learn_more),
            )
            .into_any_element()
    };
    Stack::new()
        .gap(Space::Lg)
        .child(buttons)
        .child(status)
        .into_any_element()
}
