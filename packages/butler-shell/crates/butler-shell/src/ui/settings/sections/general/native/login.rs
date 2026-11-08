//! Start at login (`StartAtLoginField`), hidden when the login item is unavailable.
mod copy;

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::context::Ds;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::toast::{self, Toast};
use butler_platform::login_item::{self, LoginItem};
use gpui::App;

use super::super::copy::GeneralCopy;
use crate::ui::settings::SectionCtx;

/// The switch reads the OS state on every render; a change writes it, then re-renders the page,
/// so a refused change shows the old state and the failure toast.
pub(in super::super) fn field(
    ctx: &SectionCtx,
    _copy: &'static GeneralCopy,
    cx: &App,
) -> Option<SettingsField> {
    let executable = std::env::current_exe().ok()?;
    let on = match login_item::status(&executable) {
        LoginItem::Unavailable => return None,
        LoginItem::On => true,
        LoginItem::Off => false,
    };
    let words = copy::words(Ds::get(cx).lang());
    let ctx = ctx.clone();
    Some(
        SettingsField::new(words.label)
            .setting_id("start-at-login")
            .control(Switch::new("start-at-login").checked(on).on_checked_change(
                move |checked, _, cx| {
                    if login_item::set(&executable, checked).is_err() {
                        toast::show(cx, Toast::error(words.failed));
                    }
                    // The tray's Start at login checkbox shows the same registration.
                    crate::lifecycle::tray::refresh(cx);
                    ctx.state.update(cx, |_, cx| cx.notify());
                },
            )),
    )
}
