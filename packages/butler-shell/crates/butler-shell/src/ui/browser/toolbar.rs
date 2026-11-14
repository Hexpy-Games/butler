//! AddressRow and BrowserOptions.
use super::{
    area::{AreaState, result},
    model::{BrowserState, Tab, TabStatus},
};
use crate::ui::{
    Icon,
    i18n::browser::BrowserStrings,
    manage::{self, HistoryFrom, View},
    widgets::anchor,
};
use butler_ds::ui::{
    blocks::{
        address_field::{AddressField, AddressFieldLabels, AddressSecurity},
        browser_pane::BrowserToolbar,
    },
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
    icon_button::IconButton,
    toast::{self, Toast},
};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _, Window, div,
};

#[derive(Clone, Copy)]
enum Nav {
    Back,
    Forward,
    Reload,
}

fn navigation(tab: Option<&Tab>, cx: &App) -> BrowserToolbar {
    let c = BrowserStrings::get(cx);
    let enabled = cx.global::<BrowserState>().enabled();
    let mut toolbar = BrowserToolbar::new("browser-toolbar");
    for (action, name, label, glyph, disabled) in [
        (
            Nav::Back,
            "browser-back",
            c.back,
            Icon::ArrowLeft,
            !enabled || tab.is_none_or(|t| !t.can_back),
        ),
        (
            Nav::Forward,
            "browser-forward",
            c.forward,
            Icon::ArrowRight,
            !enabled || tab.is_none_or(|t| !t.can_forward),
        ),
        (
            Nav::Reload,
            "browser-reload",
            if tab.is_some_and(|t| t.status == TabStatus::Loading) {
                c.stop
            } else {
                c.reload
            },
            if tab.is_some_and(|t| t.status == TabStatus::Loading) {
                Icon::Square
            } else {
                Icon::RefreshCcw
            },
            !enabled || tab.is_none(),
        ),
    ] {
        toolbar = toolbar.navigation(nav_button(tab, action, name, label, glyph, disabled));
    }
    toolbar
}

fn nav_button(
    tab: Option<&Tab>,
    action: Nav,
    name: &'static str,
    label: &'static str,
    glyph: Icon,
    disabled: bool,
) -> AnyElement {
    let tab = tab.cloned();
    let mut button = IconButton::new(name, label)
        .glyph(glyph)
        .on_click(move |_, _, cx| {
            if let Some(tab) = &tab {
                let model = cx.global_mut::<BrowserState>();
                let value = match action {
                    Nav::Back => model.back(&tab.id),
                    Nav::Forward => model.forward(&tab.id),
                    Nav::Reload if tab.status == TabStatus::Loading => model.stop(&tab.id),
                    Nav::Reload => model.reload(&tab.id),
                };
                result(&value, cx);
            }
        });
    if disabled {
        button = button.disabled();
    }
    anchor(div(), name)
        .flex()
        .flex_none()
        .child(button)
        .into_any_element()
}

fn address(tab: Option<&Tab>, state: &Entity<AreaState>, cx: &mut App) -> AddressField {
    let c = BrowserStrings::get(cx);
    let enabled = cx.global::<BrowserState>().enabled();
    let url = tab.map_or("", |t| t.url.as_str());
    let editing = state.clone();
    let submitted = state.clone();
    let id = tab.map(|t| t.id.clone());
    let mut field = AddressField::new("browser-address-field")
        .url(url.to_owned())
        .security(if url.is_empty() {
            AddressSecurity::Internal
        } else if url.starts_with("https:") {
            AddressSecurity::Secure
        } else {
            AddressSecurity::Insecure
        })
        .labels(AddressFieldLabels {
            field: c.address.into(),
            placeholder: c.address_placeholder.into(),
            secure: c.secure.into(),
            insecure: c.not_secure.into(),
            ..Default::default()
        })
        .editing(state.read(cx).editing)
        .on_editing_change(move |value, _, cx| {
            editing.update(cx, |s, _| s.editing = value);
            cx.refresh_windows();
        })
        .on_submit(move |address, window, cx| {
            if let Some(id) = &id {
                let value = cx.global_mut::<BrowserState>().navigate(id, &address);
                result(&value, cx);
            }
            let focus = submitted.read(cx).focus.clone();
            focus.focus(window, cx);
        });
    if !enabled || tab.is_none() {
        field = field.disabled();
    }
    field
}

pub(super) fn toolbar(
    tab: Option<&Tab>,
    state: &Entity<AreaState>,
    window: &mut Window,
    cx: &mut App,
) -> BrowserToolbar {
    let c = BrowserStrings::get(cx);
    let toolbar = navigation(tab, cx);
    let field = address(tab, state, cx);
    let url = tab.map_or("", |t| t.url.as_str());
    let mut pick = IconButton::new("browser-pick", c.pick)
        .glyph(Icon::Pick)
        .on_click(|_, _, cx| {
            // CARVE-OUT(G-cef): pick mode lands with CEF input
            toast::show(
                cx,
                Toast::message(match butler_ds::ui::context::Ds::get(cx).lang() {
                    butler_ds::ui::context::Lang::Ko => {
                        crate::ui::i18n::Locale::Ko.strings().not_yet
                    }
                    butler_ds::ui::context::Lang::En => {
                        crate::ui::i18n::Locale::En.strings().not_yet
                    }
                }),
            );
        });
    if url.is_empty() {
        pick = pick.disabled();
    }
    toolbar
        .address(anchor(div(), "browser-address").w_full().child(field))
        .action(pick)
        .action(options(window, cx))
}
fn options(window: &mut Window, cx: &mut App) -> AnyElement {
    let c = BrowserStrings::get(cx);
    let menu = DropdownMenu::new("browser-options", window, cx);
    let trigger = menu.trigger(|toggle| {
        IconButton::new("browser-more", c.more)
            .glyph(Icon::MoreHorizontal)
            .menu_trigger()
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = DropdownMenuContent::new().child(Item::new(c.history).on_select(|_, cx| {
        if let Some(ctx) = manage::window_ctx(cx) {
            ctx.set_view(
                View::History {
                    from: HistoryFrom::Browser,
                },
                cx,
            );
        }
    }));
    div()
        .child(trigger)
        .child(menu.content(content, window, cx))
        .into_any_element()
}
