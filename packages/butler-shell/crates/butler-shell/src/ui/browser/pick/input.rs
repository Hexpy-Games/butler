#[cfg(feature = "cef")]
pub(super) use super::gesture::Press;
use super::probe;
use crate::ui::browser::{engine::TabId, model::BrowserState};
use gpui::{App, Keystroke};
#[cfg(not(feature = "cef"))]
#[derive(Clone)]
pub(super) struct Press;
pub(crate) fn hover(id: &TabId, x: f64, y: f64, cx: &mut App) {
    let Some(session) = cx.global::<BrowserState>().tab(id).map(|t| t.pick.clone()) else {
        return;
    };
    session.point.set(Some((x, y)));
    session.revision.set(session.revision.get() + 1);
    if session.pending.replace(true) {
        return;
    }
    let id = id.clone();
    cx.spawn(async move |cx| {
        loop {
            let revision = session.revision.get();
            let generation = session.generation.get();
            let Some((x, y)) = session.point.get() else {
                break;
            };
            let preferred = session.preferred.borrow().clone();
            let mut result = probe::probe(&id, x, y, preferred.as_deref(), cx).await;
            if revision != session.revision.get() {
                continue;
            }
            cx.update(|cx| {
                if let Some(tab) = cx.global_mut::<BrowserState>().tabs.iter_mut().find(|t| {
                    t.id == id
                        && t.picking
                        && t.pick.generation.get() == generation
                        && t.pick.down.borrow().is_none()
                }) {
                    if let Ok(hover) = result.as_mut() {
                        let preferred = tab.pick.preferred.borrow().clone();
                        if let Some(preferred) = preferred {
                            if let Some(index) = hover
                                .levels
                                .iter()
                                .position(|l| l.data["identity"] == preferred)
                            {
                                hover.index = index;
                                probe::label(hover);
                            } else {
                                tab.pick.preferred.borrow_mut().take();
                            }
                        }
                    }
                    tab.pick_hover = result.ok().filter(|h| !h.levels.is_empty());
                }
                cx.refresh_windows();
            });
            break;
        }
        session.pending.set(false);
    })
    .detach();
}
pub(crate) fn key(id: &TabId, key: &Keystroke, up: bool, cx: &mut App) -> bool {
    let model = cx.global::<BrowserState>();
    let picking = model.tab(id).is_some_and(|t| t.picking);
    let shortcut = is_shortcut(key);
    if shortcut {
        if !up {
            super::mode(id, true, cx);
        }
        return true;
    }
    if !picking {
        return false;
    }
    match key.key.as_str() {
        "escape" => {
            if !up {
                super::mode(id, false, cx);
            }
            true
        }
        "up" | "down" => {
            if !up {
                step(id, key.key == "up", cx);
            }
            true
        }
        _ => true,
    }
}
pub(crate) fn step(id: &TabId, wider: bool, cx: &mut App) {
    if let Some(tab) = cx
        .global_mut::<BrowserState>()
        .tabs
        .iter_mut()
        .find(|t| &t.id == id && t.picking)
    {
        if tab.pick.down.borrow().is_some() {
            return;
        }
        if let Some(hover) = tab.pick_hover.as_mut() {
            hover.index = if wider {
                (hover.index + 1).min(hover.levels.len().saturating_sub(1))
            } else {
                hover.index.saturating_sub(1)
            };
            *tab.pick.preferred.borrow_mut() = hover
                .levels
                .get(hover.index)
                .and_then(|l| l.data["identity"].as_str())
                .map(str::to_owned);
            probe::label(hover);
        }
    }
    cx.refresh_windows();
}

#[cfg(feature = "cef")]
pub(crate) fn wheel(id: &TabId, delta: f32, cx: &mut App) {
    let Some(session) = cx
        .global::<BrowserState>()
        .tab(id)
        .filter(|t| t.picking)
        .map(|t| t.pick.clone())
    else {
        return;
    };
    let value = session.wheel.get() + delta;
    if value.abs() >= 40. {
        session.wheel.set(0.);
        step(id, value > 0., cx);
    } else {
        session.wheel.set(value);
    }
}

fn is_shortcut(key: &Keystroke) -> bool {
    let m = key.modifiers;
    key.key.eq_ignore_ascii_case("s")
        && m.shift
        && !m.alt
        && if butler_platform::launcher::node_platform() == "darwin" {
            m.platform && !m.control
        } else {
            m.control && !m.platform
        }
}

pub(crate) fn scope<E: gpui::InteractiveElement>(element: E, id: Option<TabId>) -> E {
    let picked = id.clone();
    element
        .on_action(move |_: &super::super::area::Pick, _, cx| {
            if let Some(id) = &picked {
                super::mode(id, true, cx);
            }
        })
        .on_key_down(move |event, _, cx| {
            if (event.keystroke.key == "escape" || is_shortcut(&event.keystroke))
                && let Some(id) = &id
                && key(id, &event.keystroke, false, cx)
            {
                cx.stop_propagation();
            }
        })
}
