//! The General fields that need what only the Electron main process has: the notification
//! permission panel (`NativeNotificationStatusPanel`), rerun setup (`RerunSetupField`) and the
//! full reset (`FullResetSection`, `useFullReset`).
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::tooltip::Tooltip;
use gpui::ParentElement as _;

use super::copy::GeneralCopy;

/// `platformLabel`
fn platform_label() -> &'static str {
    match crate::ui::theme::Platform::host() {
        crate::ui::theme::Platform::Mac => "macOS",
        crate::ui::theme::Platform::Windows => "Windows",
        crate::ui::theme::Platform::Linux => "Linux",
    }
}

/// The notification permission section. CARVE-OUT(G-native): React asks Electron for the
/// permission status, sends the test notification and opens the system settings. The shell
/// has no such capability yet, so the section states that desktop notifications are not
/// supported, and the Test and Open settings buttons are absent.
pub(super) fn notification_permission(copy: &'static GeneralCopy) -> SettingsSection {
    let status = format!("{} · {}", platform_label(), copy.unsupported);
    SettingsSection::new(
        "notification-permission",
        SettingsSectionKind::Status,
        copy.sections[5],
    )
    .description(copy.section_descriptions[1])
    .holds_fields()
    .child(
        SettingsField::new(copy.notification_status)
            .description(copy.notification_unsupported)
            .meta_text(status)
            .setting_id("notification-permission"),
    )
}

/// CARVE-OUT(G-onboard): React opens the first-run flow again; that flow is not ported, so the
/// button is present and disabled with the not-yet reason.
pub(super) fn rerun_setup(copy: &'static GeneralCopy) -> SettingsField {
    let [title, description, action] = copy.rerun;
    SettingsField::new(title)
        .description(description)
        .setting_id("rerun-setup")
        .control(
            Tooltip::new("rerun-setup-reason")
                .label(copy.not_yet)
                .child(
                    Button::new("rerun-setup")
                        .variant(Variant::Outline)
                        .text(action)
                        .aria_disabled(),
                ),
        )
}

/// The full reset section. CARVE-OUT(G-native): React confirms with a typed phrase, then calls
/// the admin `/data/reset` and has Electron stop the agent and relaunch the app. The shell has
/// no agent stop and relaunch, so the button is present and disabled with the not-yet reason.
pub(super) fn full_reset(copy: &'static GeneralCopy) -> SettingsSection {
    let [label, description, action] = copy.full_reset;
    SettingsSection::new("full-reset", SettingsSectionKind::Form, copy.sections[9]).child(
        SettingsField::new(label)
            .description(description)
            .setting_id("full-reset")
            .control(
                Tooltip::new("full-reset-reason").label(copy.not_yet).child(
                    Button::new("full-reset")
                        .variant(Variant::Destructive)
                        .text(action)
                        .aria_disabled(),
                ),
            ),
    )
}
