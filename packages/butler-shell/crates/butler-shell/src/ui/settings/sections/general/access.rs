//! `AccessModeSettingsField` (+ `AccessModeOptions`): a settings field that picks an access mode
//! from the composer's access list.
use butler_ds::ui::blocks::option_menu::{OptionMenu, OptionMenuItem};
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::layout::{Inline, Space};
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::select_button::SelectButton;
use butler_ds::ui::tooltip::Align;
use gpui::{App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window, div};
use serde_json::json;

use super::copy::GeneralCopy;
use crate::ui::composer::menus::{
    ACCESS_MODES, access_description, access_label, access_mode_icon, access_permission_tone,
};
use crate::ui::settings::{Save, SectionCtx};
use crate::ui::source::wire::AccessMode;

/// The props of one field (`settingId`, `label`, `description`, `factoryDefault`) and the
/// setting it saves.
pub(super) struct Field {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) description: &'static str,
    pub(super) key: &'static str,
    pub(super) factory_default: AccessMode,
}

/// The wire value of a mode (`Unknown` reads as Ask first, as the menus do).
fn wire(mode: &AccessMode) -> &'static str {
    match mode {
        AccessMode::ReadOnly => "read_only",
        AccessMode::AskFirst => "ask_first",
        AccessMode::AskExceptReads | AccessMode::Unknown => "ask_except_reads",
        AccessMode::Auto => "auto",
        AccessMode::FullAccess => "full_access",
    }
}

/// `AccessModeOptions`: a row per mode; picking one saves it and closes the popover.
fn options(
    ctx: &SectionCtx,
    spec: &Field,
    value: &AccessMode,
    popover: &Popover,
    copy: &'static GeneralCopy,
    cx: &App,
) -> OptionMenu {
    let ds = Ds::get(cx);
    let lang = ds.lang();
    let mut menu = OptionMenu::new("");
    for mode in ACCESS_MODES {
        // CARVE-OUT(DS): OptionMenuItem takes a text label, so the Recommended tag and the
        // Default caption of React's label node are plain text after the name.
        let mut label = SharedString::from(access_label(&mode, lang));
        let marks = [
            (mode == AccessMode::Auto).then_some(copy.recommended),
            (mode == spec.factory_default).then_some(copy.default_mark),
        ];
        for mark in marks.into_iter().flatten() {
            label = format!("{label} · {mark}").into();
        }
        let (ctx, popover, key, chosen) = (ctx.clone(), popover.clone(), spec.key, mode.clone());
        let mut item = OptionMenuItem::new((ElementId::from(spec.id), label.clone()), label)
            .description(access_description(&mode, lang))
            .block_description()
            .icon(access_mode_icon(&mode, IconSize::Md, ds))
            .permission_tone(access_permission_tone(&mode))
            .on_click(move |_, window, cx| {
                ctx.save(json!({ key: wire(&chosen) }), Save::default(), cx);
                popover.set_open(false, window, cx);
            });
        if mode == *value {
            item = item.selected();
        }
        menu = menu.child(item);
    }
    menu
}

pub(super) fn field(
    ctx: &SectionCtx,
    spec: &Field,
    value: &AccessMode,
    copy: &'static GeneralCopy,
    window: &mut Window,
    cx: &mut App,
) -> SettingsField {
    let popover = Popover::new(spec.id, window, cx);
    let menu = options(ctx, spec, value, &popover, copy, cx);
    let ds = Ds::get(cx);
    let glyph = access_mode_icon(value, IconSize::Sm, ds);
    let name = access_label(value, ds.lang());
    let trigger_id = SharedString::from(format!("{}-trigger", spec.id));
    let trigger = popover.trigger(|toggle| {
        SelectButton::new(trigger_id)
            .child(
                Inline::new()
                    .gap(Space::Xs)
                    .wrap(false)
                    .child(glyph)
                    .child(name),
            )
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .side_offset(6.)
            .menu_size(MenuSize::Compact)
            .child(menu),
        window,
        cx,
    );
    SettingsField::new(spec.label)
        .description(spec.description)
        .setting_id(spec.id)
        .control(div().child(trigger).child(content))
}
