//! Electron `ButlerVaultSection.tsx`, including the non-admin security branch.
use super::{Protection, State, Vault, copy::words};
use butler_ds::ui::{
    blocks::{
        settings_field::SettingsField,
        settings_section::{SettingsSection, SettingsSectionKind, SettingsSectionState},
    },
    button::Button,
    context::Ds,
    toast::{self, Toast},
    typo::Typo,
};
use gpui::{App, Entity, ParentElement as _, prelude::FluentBuilder as _};

pub(crate) fn section(vault: &Entity<Vault>, cx: &App) -> Option<SettingsSection> {
    let model = vault.read(cx);
    let view = model
        .view
        .as_ref()
        .filter(|_| model.state == State::Ready)?;
    if matches!(view.state, Protection::Off) && !view.available {
        return None;
    }
    let copy = words(Ds::get(cx).lang());
    let section = SettingsSection::new("butler-vault", SettingsSectionKind::Form, copy.name);
    if matches!(view.state, Protection::Locked) {
        return Some(
            section
                .state(SettingsSectionState::Empty)
                .empty_message(copy.locked),
        );
    }
    let section = section.description(if matches!(view.state, Protection::Protected) {
        copy.protected
    } else {
        copy.off
    });
    if matches!(view.state, Protection::Protected) {
        let kinds = view
            .counts
            .as_ref()
            .map(|counts| counts.kinds(Ds::get(cx).lang()))
            .unwrap_or_default();
        return Some(if kinds.is_empty() {
            section
        } else {
            section.child(
                SettingsField::new(copy.stored)
                    .setting_id("butler-vault-stored")
                    .control(Typo::body(kinds)),
            )
        });
    }
    let entity = vault.clone();
    Some(
        section.child(
            SettingsField::new(copy.turn_on_label)
                .setting_id("butler-vault-turn-on")
                .description(copy.intro)
                .control(
                    Button::new("butler-vault-enable")
                        .text(copy.turn_on)
                        .when(model.busy, Button::disabled)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |vault, cx| {
                                vault.enable(
                                    move |ok, cx| {
                                        toast::show(
                                            cx,
                                            if ok {
                                                Toast::success(copy.turned_on)
                                            } else {
                                                Toast::error(copy.failed)
                                            },
                                        );
                                    },
                                    cx,
                                );
                            });
                        }),
                ),
        ),
    )
}

impl Vault {
    pub(crate) fn section(entity: &Entity<Self>, cx: &App) -> Option<SettingsSection> {
        section(entity, cx)
    }
}
