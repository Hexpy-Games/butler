//! Isolated-world browser reader and selection wire types.
mod copy;
mod follow;
mod geometry;
mod input;
mod probe;
mod reader;
mod view;
use super::{
    agent_host::Holder,
    engine::{PageChange, PageEvent, TabId},
    model::BrowserState,
};
pub(crate) use copy::words;
use gpui::App;
pub(crate) use input::step;
#[cfg(feature = "cef")]
pub(crate) use input::{Mouse, mouse, wheel};
use serde_json::Value;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
pub(crate) use view::overlay;
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
    wheel: Rc<Cell<f32>>,
    press_id: Rc<Cell<u64>>,
    down: Rc<RefCell<Option<input::Press>>>,
    watches: Rc<RefCell<HashMap<Vec<usize>, gpui::Task<()>>>>,
}
impl Session {
    pub(crate) fn viewport(&self) -> (f64, f64) {
        self.viewport.get()
    }
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

/// Electron `selection.mode`: a page the Agent holds but is not using is taken over; one it uses refuses.
pub(crate) fn mode(id: &TabId, value: bool, cx: &mut App) {
    let model = cx.global_mut::<BrowserState>();
    if !model.engine.supports_devtools() || model.tab(id).is_none_or(|t| t.url.is_empty()) {
        return;
    }
    if value {
        if model.agent_gate(id).is_err() {
            return;
        }
        if model
            .tab(id)
            .and_then(|t| t.hosted.as_ref())
            .is_some_and(|h| h.holder == Holder::Agent)
        {
            model.control(id, Holder::User, false);
        }
    }
    let Some(tab) = model.tabs.iter_mut().find(|t| &t.id == id) else {
        return;
    };
    tab.picking = value;
    tab.pick_hover = None;
    let session = tab.pick.clone();
    session.point.set(None);
    session.down.borrow_mut().take();
    session.preferred.borrow_mut().take();
    session.revision.set(session.revision.get() + 1);
    session.wheel.set(0.);
    session.focus_requested.set(value);
    model.publisher.changed(&model.tabs);
    if value {
        let id = id.clone();
        cx.spawn(async move |cx| {
            let _ = reader::protocol(&id, "Page.enable", json!({}), cx).await;
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
/// The picks changed: publish (selectionCount), re-follow, redraw.
fn changed(id: &TabId, cx: &mut App) {
    let model = cx.global::<BrowserState>();
    model.publisher.changed(&model.tabs);
    follow::sync(id, cx);
    cx.refresh_windows();
}
/// Electron `navigated`: a new main document drops the worlds and the picks; a sub-frame's drops only its own state.
pub(crate) fn page_event(event: &PageEvent, cx: &mut App) {
    let PageChange::DevToolsEvent { method, params } = &event.change else {
        return;
    };
    let document = match method.as_str() {
        "Page.frameNavigated" => true,
        "Page.navigatedWithinDocument" => false,
        _ => return,
    };
    let subframe = document && params["frame"].get("parentId").is_some();
    let model = cx.global_mut::<BrowserState>();
    let Some(tab) = model.tabs.iter_mut().find(|t| t.id == event.page) else {
        return;
    };
    if subframe {
        let session = tab.pick.clone();
        session
            .worlds
            .borrow_mut()
            .retain(|path, _| path.is_empty());
        session
            .frames
            .borrow_mut()
            .retain(|path, _| path.is_empty());
        session
            .watches
            .borrow_mut()
            .retain(|path, _| path.is_empty());
        follow::sync(&event.page, cx);
        return;
    }
    tab.pick_hover = None;
    let session = tab.pick.clone();
    session.preferred.borrow_mut().take();
    session.revision.set(session.revision.get() + 1);
    if document {
        session.worlds.borrow_mut().clear();
        session.frames.borrow_mut().clear();
        session.watches.borrow_mut().clear();
        session.down.borrow_mut().take();
        session.generation.set(session.generation.get() + 1);
        tab.selections.clear();
    }
    model.publisher.changed(&model.tabs);
    follow::sync(&event.page, cx);
}
