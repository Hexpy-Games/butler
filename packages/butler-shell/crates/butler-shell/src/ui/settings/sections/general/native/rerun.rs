//! Run setup again (`RerunSetupField`): Settings closes and the first-run flow shows again.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::button::{Button, Variant};
use gpui::App;

use super::super::copy::GeneralCopy;
use crate::ui::settings::SectionCtx;

pub(in super::super) fn field(ctx: &SectionCtx, copy: &'static GeneralCopy) -> SettingsField {
    let [title, description, action] = copy.rerun;
    let ctx = ctx.clone();
    SettingsField::new(title)
        .description(description)
        .setting_id("rerun-setup")
        .control(
            Button::new("rerun-setup")
                .variant(Variant::Outline)
                .text(action)
                .on_click(move |_, _, cx: &mut App| ctx.rerun_setup(cx)),
        )
}
