//! The browser sheet (`BrowserArea.tsx`), shared by the hub and conversation slot.
use super::{
    engine::TabId,
    model::{BrowserError, BrowserState, Owner, Tab, TabStatus},
    shell_state::BrowserShell,
};
use crate::ui::{i18n::browser::BrowserStrings, manage, widgets::anchor};
use butler_ds::ui::blocks::{
    browser_pane::{BrowserPane, PanePlacement},
    empty_line::EmptyLine,
    page_band::{PageBand, PageBandTone},
    page_card::PageCard,
};
use butler_ds::ui::{
    button::{Button, Variant},
    toast::{self, Toast},
};
use gpui::{AnyElement, App, Entity, Window, div, prelude::*};
use std::collections::HashSet;

gpui::actions!(
    browser,
    [FocusAddress, NewTab, CloseTab, Back, Forward, Pick]
);
pub(crate) fn bindings() -> Vec<gpui::KeyBinding> {
    vec![
        // The shell field unbinds Enter for its composer; the DS address owns submission.
        gpui::KeyBinding::new(
            "enter",
            gpui_elements::editable_text::actions::Enter,
            Some("BrowserArea > EditableText"),
        ),
        gpui::KeyBinding::new("secondary-shift-s", Pick, Some("BrowserArea")),
        gpui::KeyBinding::new("secondary-l", FocusAddress, Some("BrowserArea")),
        gpui::KeyBinding::new("secondary-t", NewTab, Some("BrowserArea")),
        gpui::KeyBinding::new("secondary-w", CloseTab, Some("BrowserArea")),
        gpui::KeyBinding::new("secondary-[", Back, Some("BrowserArea")),
        gpui::KeyBinding::new("alt-left", Back, Some("BrowserArea")),
        gpui::KeyBinding::new("secondary-]", Forward, Some("BrowserArea")),
        gpui::KeyBinding::new("alt-right", Forward, Some("BrowserArea")),
    ]
}

pub(super) struct AreaState {
    pub(super) focus: gpui::FocusHandle,
    pub(super) editing: bool,
    address: Option<(TabId, String)>,
    pub(super) collapsed: HashSet<String>,
    creating: bool,
    _library: Option<gpui::Subscription>,
    pub(super) suggestions: super::suggestions::Suggestions,
    pub(super) bookmarks: super::bookmarks::Bookmarks,
}

pub(crate) fn result<T>(value: &Result<T, BrowserError>, cx: &mut App) {
    if value.is_err() {
        toast::show(cx, Toast::error(BrowserStrings::get(cx).failed));
    }
    super::popup_window::sync(cx);
    cx.refresh_windows();
}
pub(crate) fn create(owner: Owner, cx: &mut App) {
    let value =
        cx.update_global::<BrowserState, _>(|model, cx| model.create(owner, None, false, true, cx));
    result(&value, cx);
}
pub(super) fn owner_key(owner: &Owner) -> String {
    match owner {
        Owner::Mine => "mine".into(),
        Owner::Conversation(id) => format!("conversation:{id}"),
    }
}
pub(super) fn title(session: &str, cx: &App) -> Option<String> {
    let nav = manage::window_ctx(cx)?.navigation(cx)?;
    nav.chats
        .iter()
        .chain(
            nav.projects
                .iter()
                .flat_map(|p| p.sessions.iter().flatten()),
        )
        .find(|s| s.id == session)
        .map(|s| s.title.clone())
}
fn visible(session: Option<&str>, tab: &Tab, cx: &App) -> bool {
    match (&tab.owner, session) {
        (Owner::Mine, None) => true,
        (Owner::Conversation(id), Some(session)) => id.as_ref() == session,
        (Owner::Conversation(id), None) => title(id, cx).is_some(),
        _ => false,
    }
}
fn shown(session: Option<&str>, state: &Entity<AreaState>, cx: &mut App) -> Vec<Tab> {
    let model = cx.global::<BrowserState>();
    let tabs: Vec<_> = model
        .tabs()
        .iter()
        .filter(|t| !t.popup && visible(session, t, cx))
        .cloned()
        .collect();
    let active = model.active().cloned();
    let remembered = session.and_then(|id| cx.global::<BrowserShell>().remembered(id));
    let tab = tabs
        .iter()
        .find(|t| Some(&t.id) == active.as_ref())
        .or_else(|| tabs.iter().find(|t| Some(&t.id) == remembered))
        .or(tabs.first());
    if let Some(tab) = tab {
        let id = tab.id.clone();
        let address = Some((id.clone(), tab.url.clone()));
        if state.read(cx).address != address {
            state.update(cx, |s, _| {
                s.editing = tab.url.is_empty();
                s.address = address;
                s.suggestions.reset();
            });
        }
        if active.as_ref() != Some(&id) {
            cx.global_mut::<BrowserState>().activate(&id);
        }
        if let Owner::Conversation(session) = &tab.owner {
            cx.global_mut::<BrowserShell>().remember_tab(session, id);
        }
    }
    tabs
}
fn page(tab: Option<&Tab>, key: &str, window: &mut Window, cx: &mut App) -> PageCard {
    let c = BrowserStrings::get(cx);
    let enabled = cx.global::<BrowserState>().enabled();
    let empty = tab.is_none_or(|t| t.url.is_empty());
    let crashed = tab.is_some_and(|t| t.status == TabStatus::Crashed);
    let mut page = PageCard::new("browser-page")
        .panel_id("browser-page")
        .reserve_band()
        .hidden(empty || crashed || !enabled);
    if let Some(tab) = tab {
        if let Some(band) = super::pick::band(tab, cx).or_else(|| popup_band(tab, cx)) {
            page = page.band(band);
        }
        if tab.picking || !tab.selections.is_empty() {
            page = page.overlay(super::pick::overlay(tab, window, cx));
        }
        if let Some(dialog) = &tab.dialog {
            page = page.overlay(super::dialog::show(&tab.id, dialog, window, cx));
        }
        let id = tab.id.clone();
        let surface =
            cx.update_global::<BrowserState, _>(|model, cx| model.surface(&id, window, cx));
        if let Some(surface) = surface {
            page = page.page(anchor(div(), "browser-page").size_full().child(surface));
        }
        page = page.on_bounds_change(move |bounds, window, cx| {
            if bounds.visible {
                let zoom = window.zoom();
                cx.global_mut::<BrowserState>().resize(
                    &id,
                    bounds.bounds.size.map(|length| length * zoom),
                    bounds.scale * window.scale_factor() / zoom,
                );
            }
        });
    }
    if empty && enabled && !crashed {
        page = page
            .internal(anchor(div(), "browser-page").child(super::new_tab::page(key, window, cx)));
    } else if crashed || !enabled {
        let mut line = EmptyLine::new(if enabled {
            c.crashed
        } else {
            c.update_required
        });
        if enabled && let Some(tab) = tab {
            let id = tab.id.clone();
            line = line.action(
                Button::new("browser-crash-reload")
                    .variant(Variant::Outline)
                    .text(c.reload)
                    .on_click(move |_, _, cx| {
                        let value = cx.global_mut::<BrowserState>().reload(&id);
                        result(&value, cx);
                    }),
            );
        }
        page = page.internal(anchor(div(), "browser-page").child(line));
    }
    page
}
pub(crate) fn browser_area(session: Option<&str>, window: &mut Window, cx: &mut App) -> AnyElement {
    let restored = super::restore::ready(cx);
    let state = area_state(session, window, cx);
    let tabs = shown(session, &state, cx);
    let owner = session.map_or(Owner::Mine, |s| Owner::Conversation(s.to_owned().into()));
    if cx.global::<BrowserShell>().address_focus.as_ref() == Some(&owner) {
        cx.global_mut::<BrowserShell>().address_focus = None;
        state.update(cx, |s, _| s.editing = true);
    }
    if !tabs.is_empty() {
        state.update(cx, |s, _| s.creating = false);
    }
    let known = session.is_some()
        || manage::window_ctx(cx)
            .and_then(|ctx| ctx.navigation(cx))
            .is_some();
    if restored
        && tabs.is_empty()
        && known
        && cx.global::<BrowserState>().enabled()
        && !state.read(cx).creating
    {
        state.update(cx, |s, _| s.creating = true);
        let owner = session.map_or(Owner::Mine, |s| Owner::Conversation(s.to_owned().into()));
        let value = cx.update_global::<BrowserState, _>(|model, cx| {
            model.create(owner, None, true, true, cx)
        });
        result(&value, cx);
    }
    let active = cx.global::<BrowserState>().active();
    let tab = tabs.iter().find(|t| Some(&t.id) == active);
    let shown = tab
        .filter(|t| !t.url.is_empty() && t.status != TabStatus::Crashed)
        .map(|t| t.id.clone());
    cx.global_mut::<BrowserState>().show(shown.as_ref());
    let strip = super::tabs::strip(&tabs, session, &state, window, cx);
    let toolbar = super::toolbar::toolbar(tab, &state, window, cx);
    let page = page(tab, session.unwrap_or("standalone"), window, cx);
    let pane = BrowserPane::new(
        "browser-pane",
        BrowserStrings::get(cx).title,
        strip,
        toolbar,
        page,
    )
    .placement(if session.is_some() {
        PanePlacement::Conversation
    } else {
        PanePlacement::Standalone
    });
    let focus = state.read(cx).focus.clone();
    let element = anchor(div().id("browser-area"), "browser-area")
        .track_focus(&focus)
        .key_context("BrowserArea")
        .size_full()
        .flex()
        .child(pane);
    super::pick::scope(element, tab.map(|t| t.id.clone())).into_any_element()
}
fn area_state(session: Option<&str>, window: &mut Window, cx: &mut App) -> Entity<AreaState> {
    let key = session.unwrap_or("standalone").to_owned();
    window.use_keyed_state(
        (
            gpui::ElementId::Name(format!("browser:{key}").into()),
            "area",
        ),
        cx,
        |_, cx| {
            let library = manage::window_ctx(cx)
                .map(|ctx| cx.observe(&ctx.live, |_, _, cx| cx.refresh_windows()));
            AreaState {
                focus: cx.focus_handle(),
                editing: false,
                address: None,
                collapsed: HashSet::new(),
                creating: false,
                _library: library,
                bookmarks: super::bookmarks::Bookmarks::default(),
                suggestions: super::suggestions::Suggestions::default(),
            }
        },
    )
}
pub(crate) fn focus_address(owner: Owner, cx: &mut App) {
    cx.global_mut::<BrowserShell>().address_focus = Some(owner);
    cx.refresh_windows();
}

fn popup_band(tab: &Tab, cx: &App) -> Option<PageBand> {
    let c = BrowserStrings::get(cx);
    let id = tab.id.clone();
    if let Some(blocked) = &tab.blocked_popup {
        let mut band =
            PageBand::new("browser-band", PageBandTone::Info, c.popup_blocked).icon(popup_icon(cx));
        if blocked.reason == "no_gesture" {
            band = band.actions(
                anchor(div(), "browser-popup-allow").child(
                    Button::new("browser-popup-allow")
                        .size(butler_ds::ui::button::Size::Xs)
                        .variant(Variant::Ghost)
                        .text(c.allow)
                        .on_click(move |_, _, cx| {
                            cx.global_mut::<BrowserState>().allow_popup(&id);
                            cx.refresh_windows();
                        }),
                ),
            );
        }
        return Some(band);
    }
    let popup = cx
        .global::<BrowserState>()
        .tabs()
        .iter()
        .find(|t| t.opener.as_ref() == Some(&tab.id))?;
    let host = url::Url::parse(&popup.url)
        .ok()
        .map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_owned())
        .unwrap_or_default();
    let child = popup.id.clone();
    Some(
        PageBand::new("browser-band", PageBandTone::Info, c.popup_opened)
            .icon(popup_icon(cx))
            .detail(host)
            .actions(
                anchor(div(), "browser-popup-show").child(
                    Button::new("browser-popup-show")
                        .size(butler_ds::ui::button::Size::Xs)
                        .variant(Variant::Ghost)
                        .text(c.show_popup)
                        .on_click(move |_, _, cx| super::popup_window::focus(&child, cx)),
                ),
            ),
    )
}

fn popup_icon(cx: &App) -> AnyElement {
    anchor(div(), "browser-band")
        .child(butler_ds::ui::icon::icon(
            butler_ds::ui::Icon::Popup,
            butler_ds::ui::icon::IconSize::Sm,
            butler_ds::ui::context::Ds::get(cx),
        ))
        .into_any_element()
}
