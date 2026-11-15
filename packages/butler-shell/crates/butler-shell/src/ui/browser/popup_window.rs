//! Child OSR pages retain their opener and have their own gpui window.
use super::{engine::TabId, model::BrowserState};
use crate::ui::{i18n::browser::BrowserStrings, widgets::anchor};
use butler_ds::ui::blocks::{page_card::PageCard, popup_window_chrome::PopupWindowChrome};
use gpui::{
    App, AppContext, Bounds, Context, Global, IntoElement, ParentElement, Render, TitlebarOptions,
    Window, WindowBounds, WindowHandle, WindowOptions, div, point, prelude::*, px, size,
};
use std::collections::HashMap;

#[derive(Default)]
struct PopupWindows(HashMap<TabId, WindowHandle<PopupWindow>>);
impl Global for PopupWindows {}
struct PopupWindow {
    id: TabId,
    focus: gpui::FocusHandle,
}

pub(super) fn sync(cx: &mut App) {
    if !cx.has_global::<PopupWindows>() {
        cx.set_global(PopupWindows::default());
    }
    let tabs: Vec<_> = cx
        .global::<BrowserState>()
        .tabs()
        .iter()
        .filter(|t| t.popup)
        .map(|t| t.id.clone())
        .collect();
    let closed: Vec<_> = cx
        .global::<PopupWindows>()
        .0
        .iter()
        .filter(|(id, _)| !tabs.contains(id))
        .map(|(id, handle)| (id.clone(), *handle))
        .collect();
    for (id, handle) in closed {
        cx.global_mut::<PopupWindows>().0.remove(&id);
        let _ = handle.update(cx, |_, window, _| window.remove_window());
    }
    for id in tabs {
        if !cx.global::<PopupWindows>().0.contains_key(&id) {
            open(id, cx);
        }
    }
}
fn open(id: TabId, cx: &mut App) {
    let main = cx
        .windows()
        .first()
        .copied()
        .and_then(|handle| handle.update(cx, |_, w, _| w.bounds()).ok());
    let popup_size = size(px(520.), px(620.));
    let bounds = main
        .map(|b| Bounds {
            origin: b.origin
                + point(
                    (b.size.width - popup_size.width) / 2.,
                    (b.size.height - popup_size.height) / 2.,
                ),
            size: popup_size,
        })
        .unwrap_or_else(|| Bounds::centered(None, popup_size, cx));
    let close = id.clone();
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(320.), px(240.))),
        titlebar: Some(TitlebarOptions {
            title: Some(BrowserStrings::get(cx).title.into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(12.), px(13.))),
        }),
        ..WindowOptions::default()
    };
    match cx.open_window(options, |window, cx| {
        window.on_window_should_close(cx, move |_, cx| {
            cx.global_mut::<BrowserState>().close(&close);
            cx.defer(sync);
            true
        });
        cx.new(|cx| {
            let focus = cx.focus_handle();
            window.focus(&focus, cx);
            PopupWindow {
                id: id.clone(),
                focus,
            }
        })
    }) {
        Ok(handle) => {
            cx.global_mut::<PopupWindows>().0.insert(id, handle);
        }
        Err(error) => eprintln!("open popup window: {error}"),
    }
}
pub(super) fn focus(id: &TabId, cx: &mut App) {
    if let Some(handle) = cx
        .try_global::<PopupWindows>()
        .and_then(|p| p.0.get(id))
        .copied()
    {
        let _ = handle.update(cx, |_, window, _| window.activate());
    }
}
impl Render for PopupWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tab = cx.global::<BrowserState>().tab(&self.id).cloned();
        let Some(tab) = tab else {
            window.remove_window();
            return div().into_any_element();
        };
        let c = BrowserStrings::get(cx);
        let host = url::Url::parse(&tab.url)
            .ok()
            .map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_owned())
            .unwrap_or_default();
        let label = [host, tab.title.clone()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let secure = tab.url.starts_with("https:");
        let id = tab.id.clone();
        let mut page = PageCard::new("popup-page").on_bounds_change(move |bounds, window, cx| {
            if bounds.visible {
                cx.global_mut::<BrowserState>().resize(
                    &id,
                    bounds.bounds.size,
                    bounds.scale * window.scale_factor(),
                );
            }
        });
        if let Some(surface) =
            cx.update_global::<BrowserState, _>(|model, cx| model.surface(&tab.id, window, cx))
        {
            page = page.page(surface);
        }
        if let Some(band) = super::pick::band(&tab, cx) {
            page = page.band(band);
        }
        if tab.picking || !tab.selections.is_empty() {
            page = page.overlay(super::pick::overlay(&tab, window, cx));
        }
        if let Some(dialog) = &tab.dialog {
            page = page.overlay(super::dialog::show(&tab.id, dialog, window, cx));
        }
        let close = tab.id.clone();
        let element = anchor(div().id("popup-window-root"), "browser-popup-window")
            .track_focus(&self.focus)
            .key_context("BrowserArea")
            .on_action(move |_: &super::area::CloseTab, window, cx| {
                cx.global_mut::<BrowserState>().close(&close);
                window.remove_window();
                cx.defer(sync);
                cx.refresh_windows();
            })
            .size_full()
            .child(
                PopupWindowChrome::new(
                    "popup-window",
                    label,
                    if secure { c.secure } else { c.not_secure },
                )
                .secure(secure)
                .fullscreen(window.is_fullscreen())
                .child(page),
            );
        super::pick::scope(element, Some(self.id.clone())).into_any_element()
    }
}
