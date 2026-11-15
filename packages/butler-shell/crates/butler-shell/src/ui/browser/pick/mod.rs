//! Electron BrowserSelection: shell-owned state, isolated DOM reads and page-card overlays.
mod actions;
mod copy;
mod follow;
mod geometry;
mod input;
mod probe;
mod reader;
mod view;
#[cfg(feature = "cef")]
pub(crate) use input::{Mouse, mouse};
pub(crate) use input::scope;
#[cfg(feature = "cef")]
pub(crate) use input::{key, wheel};
pub(crate) use view::{band, overlay};

use super::{
    engine::{PageChange, PageEvent, TabId},
    model::BrowserState,
};
use gpui::App;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

#[derive(Clone, Default)]
pub(crate) struct Session {
    worlds: Rc<RefCell<HashMap<Vec<usize>, i64>>>,
    frames: Rc<RefCell<HashMap<Vec<usize>, String>>>,
    generation: Rc<Cell<u64>>,
    revision: Rc<Cell<u64>>,
    pending: Rc<Cell<bool>>,
    point: Rc<Cell<Option<(f64, f64)>>>,
    pub(super) focus_requested: Rc<Cell<bool>>,
    pub(super) viewport: Rc<Cell<(f64, f64)>>,
    preferred: Rc<RefCell<Option<String>>>,
    #[cfg(feature = "cef")]
    wheel: Rc<Cell<f32>>,
    #[cfg(feature = "cef")]
    press_id: Rc<Cell<u64>>,
    down: Rc<RefCell<Option<input::Press>>>,
    watches: Rc<RefCell<HashMap<Vec<usize>, gpui::Task<()>>>>,
}
#[derive(Clone)]
pub(crate) struct Item {
    pub(crate) data: Value,
    frame: probe::Frame,
    pub(crate) hidden: bool,
    area: Option<Area>,
}
#[derive(Clone)]
struct Area {
    rect: Value,
    scroll: (f64, f64),
}
#[derive(Clone)]
pub(crate) struct Hover {
    levels: Vec<probe::Level>,
    index: usize,
    pub(crate) rect: Value,
    pub(crate) label: String,
}

pub(crate) fn mode(id: &TabId, value: bool, cx: &mut App) {
    let model = cx.global_mut::<BrowserState>();
    if !model.engine.supports_devtools() {
        return;
    }
    let Some(tab) = model
        .tabs
        .iter_mut()
        .find(|t| &t.id == id && !t.url.is_empty())
    else {
        return;
    };
    tab.picking = value;
    tab.pick.focus_requested.set(value);
    tab.pick_hover = None;
    tab.pick.down.borrow_mut().take();
    tab.pick.preferred.borrow_mut().take();
    tab.pick.revision.set(tab.pick.revision.get() + 1);
    if value {
        let id = id.clone();
        cx.spawn(async move |cx| {
            let _ = reader::protocol(&id, "Page.enable", json!({}), cx).await;
            let _ = reader::protocol(&id, "Runtime.enable", json!({}), cx).await;
        })
        .detach();
    }

    follow::sync(id, cx);
    cx.refresh_windows();
}
pub(crate) fn toggle(id: &TabId, cx: &mut App) {
    let picking = cx
        .global::<BrowserState>()
        .tab(id)
        .is_some_and(|t| t.picking);
    mode(id, !picking, cx);
}
pub(crate) fn clear(id: &TabId, cx: &mut App) {
    if let Some(tab) = cx
        .global_mut::<BrowserState>()
        .tabs
        .iter_mut()
        .find(|t| &t.id == id)
    {
        tab.selections.clear();
    }
    follow::sync(id, cx);
    cx.refresh_windows();
}
pub(crate) fn navigation(event: &PageEvent, cx: &mut App) {
    let PageChange::DevToolsEvent { method, params } = &event.change else {
        return;
    };
    if !matches!(
        method.as_str(),
        "Runtime.executionContextsCleared" | "Page.frameNavigated" | "Page.navigatedWithinDocument"
    ) {
        return;
    }
    let model = cx.global_mut::<BrowserState>();
    if !model.engine.supports_devtools() {
        return;
    }
    let Some(tab) = model.tabs.iter_mut().find(|t| t.id == event.page) else {
        return;
    };
    tab.pick_hover = None;
    tab.pick.preferred.borrow_mut().take();
    tab.pick.revision.set(tab.pick.revision.get() + 1);
    if method == "Runtime.executionContextsCleared" || method == "Page.frameNavigated" {
        tab.pick.worlds.borrow_mut().clear();
        tab.pick.frames.borrow_mut().clear();
        tab.pick.watches.borrow_mut().clear();
        tab.pick.generation.set(tab.pick.generation.get() + 1);
        if method == "Runtime.executionContextsCleared" || params["frame"].get("parentId").is_none()
        {
            tab.selections.clear();
        }
    } else {
        tab.selections.retain(|item| item.area.is_none());
    }
    follow::sync(&event.page, cx);
}
