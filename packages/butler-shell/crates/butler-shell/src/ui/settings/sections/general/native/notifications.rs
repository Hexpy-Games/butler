//! The notification permission section (`NativeNotificationStatusPanel`).
mod copy;

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_platform::notification_settings::{self, NotificationSupport};
use gpui::{App, IntoElement, ParentElement as _, Styled as _, div};

use self::copy::{NotificationCopy, words};
use super::super::copy::GeneralCopy;
use crate::ui::settings::SectionCtx;
use crate::ui::theme::Platform;

/// `platformLabel`
fn platform_label() -> &'static str {
    match Platform::host() {
        Platform::Mac => "macOS",
        Platform::Windows => "Windows",
        Platform::Linux => "Linux",
    }
}

/// Whether this running build can post OS notifications.
fn supported() -> bool {
    std::env::current_exe()
        .is_ok_and(|exe| notification_settings::support(&exe) == NotificationSupport::Supported)
}

/// `nativeNotificationStatusDetails`: the hint for the platform's details code.
fn details(copy: &'static NotificationCopy) -> &'static str {
    match notification_settings::details_code() {
        "macos-permission" => copy.details[0],
        "windows-shortcut" => copy.details[1],
        _ => copy.details[2],
    }
}

/// `nativeNotificationSettingsLabel`
fn settings_label(copy: &'static NotificationCopy) -> &'static str {
    match Platform::host() {
        Platform::Mac => copy.settings[0],
        Platform::Windows => copy.settings[1],
        Platform::Linux => copy.settings[2],
    }
}

/// `runTestNotification`: gpui posts without reporting back, so a supported build counts as
/// shown, as Electron's own 1.5 s fallback does.
fn send_test(copy: &'static NotificationCopy, supported: bool, cx: &mut App) {
    let toast = if supported {
        cx.show_system_notification(gpui::SystemNotification {
            tag: "test".into(),
            title: copy.test_message[0].into(),
            body: copy.test_message[1].into(),
            actions: Vec::new(),
        });
        Toast::success(copy.sent)
    } else {
        Toast::error(copy.hidden)
    };
    toast::show(cx, toast);
}

pub(in super::super) fn section(
    _ctx: &SectionCtx,
    copy: &'static GeneralCopy,
    cx: &App,
) -> SettingsSection {
    let words = words(Ds::get(cx).lang());
    let supported = supported();
    let (description, check) = if supported {
        (details(words), words.permission_check)
    } else {
        (copy.notification_unsupported, copy.unsupported)
    };
    let test = Button::new("notification-test")
        .variant(Variant::Outline)
        .text(words.test)
        .on_click(move |_, _, cx| send_test(words, supported, cx));
    let open = notification_settings::settings_url().map(|url| {
        Button::new("notification-open-settings")
            .variant(Variant::Outline)
            .text(settings_label(words))
            .on_click(move |_, _, cx| cx.open_url(url))
    });
    let control = div()
        .flex()
        .flex_wrap()
        .gap_2()
        .child(test)
        .children(open)
        .into_any_element();
    SettingsSection::new(
        "notification-permission",
        SettingsSectionKind::Status,
        copy.sections[5],
    )
    .description(copy.section_descriptions[1])
    .holds_fields()
    .child(
        SettingsField::new(copy.notification_status)
            .description(description)
            .control(control)
            .meta_text(format!("{} · {check}", platform_label()))
            .setting_id("notification-permission"),
    )
}
