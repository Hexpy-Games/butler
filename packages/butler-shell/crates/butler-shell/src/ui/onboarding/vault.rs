//! Electron `FirstRunVault.tsx`: the optional vault step on the shared onboarding card.
use super::{Onboarding, Screen, card::step_card};
use crate::ui::shell::vault::{Vault, copy::words};
use butler_ds::ui::{blocks::setup_wizard_step_card::SetupWizardStepAction, button::Variant};
use gpui::{AnyElement, Context, IntoElement as _, Window, prelude::FluentBuilder as _};

pub(crate) fn screen(
    view: &Onboarding,
    _: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let busy = view.vault.read(cx).busy;
    let done = view.vault_result == "done";
    let description = match view.vault_result {
        "done" => copy.done,
        "failed" => copy.failed,
        _ => copy.intro,
    };
    let mut card = step_card(view, "vault", copy.name, [], cx).description(description);
    if !done {
        card = card
            .on_back(
                super::words(view.lang).back,
                cx.listener(|view, _, _, cx| {
                    view.screen = Screen::Memory;
                    view.sync(cx);
                }),
            )
            .action(
                SetupWizardStepAction::new("first-run-vault-skip", copy.skip)
                    .variant(Variant::Secondary)
                    .when(busy, SetupWizardStepAction::disabled)
                    .on_click(cx.listener(|view, _, _, cx| {
                        let weak = cx.entity().downgrade();
                        Vault::decline(
                            &view.vault,
                            &view.vault_confirm,
                            view.lang,
                            move |ok, cx| {
                                if ok {
                                    let _ = weak.update(cx, |view, cx| {
                                        view.screen = Screen::Connect;
                                        view.sync(cx);
                                    });
                                }
                            },
                            cx,
                        );
                    })),
            );
    }
    card.action(
        SetupWizardStepAction::new("first-run-vault-continue", copy.continue_)
            .forward()
            .when(busy, SetupWizardStepAction::disabled)
            .on_click(cx.listener(move |view, _, _, cx| {
                if done {
                    view.screen = Screen::Connect;
                    view.sync(cx);
                    return;
                }
                let weak = cx.entity().downgrade();
                view.vault.update(cx, |vault, cx| {
                    vault.enable(
                        move |ok, cx| {
                            let _ = weak.update(cx, |view, cx| {
                                view.vault_result = if ok { "done" } else { "failed" };
                                cx.notify();
                            });
                        },
                        cx,
                    );
                });
            })),
    )
    .into_any_element()
}
