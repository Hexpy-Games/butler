//! Site data (`BrowserSiteDataSection.tsx`): clears the in-app browser's cookies, site data and
//! cache. Saved sign-ins live in the keychain and stay.
mod copy;

use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{App, ParentElement as _};

use copy::words;

pub(super) fn section(cx: &App) -> SettingsSection {
    let copy = words(Ds::get(cx).lang());
    // CARVE-OUT(G-native): React confirms (`confirmAction`: title, message, the items to clear, the
    // note that sign-ins stay), then calls `butlerBrowser.call("clear-site-data")` in the CEF
    // browser and toasts the result. The browser is not ported, so the button is disabled.
    let action = Tooltip::new("browser-site-data-reason")
        .label(copy.not_yet)
        .child(
            Button::new("browser-site-data-clear")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(copy.clear)
                .disabled(),
        );
    SettingsSection::new("browser-site-data", SettingsSectionKind::Form, copy.title).child(
        SettingsActionField::new(copy.label, copy.description, action)
            .setting_id("browser-site-data"),
    )
}
