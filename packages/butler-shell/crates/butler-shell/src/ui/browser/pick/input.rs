use super::probe;
use crate::ui::browser::{engine::TabId, model::BrowserState};
use gpui::App;
/// A left press while picking (Electron `selection.down`); its pick resolves asynchronously.
#[derive(Clone)]
pub(super) struct Press {
    id: u64,
    x: f64,
    y: f64,
    generation: u64,
    moved: bool,
    ended: bool,
    ready: bool,
    item: Option<super::Item>,
}
#[derive(Clone, Copy)]
pub(crate) enum Mouse {
    Move,
    Leave,
    Down { left: bool },
    Up,
}
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

/// Electron `pointer.mouse` mouseLeave → `selection.clearHover`: the pointer left the page.
pub(super) fn leave(id: &TabId, cx: &mut App) {
    let Some(tab) = cx
        .global_mut::<BrowserState>()
        .tabs
        .iter_mut()
        .find(|t| &t.id == id)
    else {
        return;
    };
    let session = tab.pick.clone();
    if tab.pick_hover.is_none() && session.point.get().is_none() {
        return;
    }
    tab.pick_hover = None;
    session.point.set(None);
    session.revision.set(session.revision.get() + 1);
    cx.refresh_windows();
}

pub(crate) fn mouse(id: &TabId, x: f64, y: f64, kind: Mouse, cx: &mut App) -> bool {
    let Some(session) = cx
        .global::<BrowserState>()
        .tab(id)
        .filter(|t| t.picking)
        .map(|t| t.pick.clone())
    else {
        return false;
    };
    match kind {
        Mouse::Move => {
            let pressed = {
                let mut down = session.down.borrow_mut();
                if let Some(press) = down.as_mut() {
                    if (x - press.x).hypot(y - press.y) > 6. {
                        press.moved = true;
                    }
                    true
                } else {
                    false
                }
            };
            if pressed {
                settle(id, cx);
            } else {
                hover(id, x, y, cx);
            }
        }
        Mouse::Leave => leave(id, cx),
        Mouse::Down { left: true } => press(id, x, y, cx),
        Mouse::Down { left: false } => {}
        Mouse::Up => {
            if let Some(press) = session.down.borrow_mut().as_mut() {
                press.ended = true;
            }
            settle(id, cx);
        }
    }
    true
}
fn press(id: &TabId, x: f64, y: f64, cx: &mut App) {
    let Some(session) = cx.global::<BrowserState>().tab(id).map(|t| t.pick.clone()) else {
        return;
    };
    let number = session.press_id.get() + 1;
    session.press_id.set(number);
    *session.down.borrow_mut() = Some(Press {
        id: number,
        x,
        y,
        generation: session.generation.get(),
        moved: false,
        ended: false,
        ready: false,
        item: None,
    });
    let preferred = session.preferred.borrow().clone();
    let id = id.clone();
    cx.spawn(async move |cx| {
        let item = probe::hit(&id, x, y, preferred.as_deref(), cx)
            .await
            .ok()
            .flatten();
        cx.update(|cx| {
            if let Some(p) = session
                .down
                .borrow_mut()
                .as_mut()
                .filter(|p| p.id == number)
            {
                p.item = item;
                p.ready = true;
            }
            settle(&id, cx);
        });
    })
    .detach();
}
fn settle(id: &TabId, cx: &mut App) {
    let Some(session) = cx.global::<BrowserState>().tab(id).map(|t| t.pick.clone()) else {
        return;
    };
    let press = {
        let mut down = session.down.borrow_mut();
        if down
            .as_ref()
            .is_some_and(|p| p.moved || (p.ready && p.ended))
        {
            down.take()
        } else {
            None
        }
    };
    // CARVE-OUT(pick-slice-2b): a drag carries the picks out (2b) or draws an area (slice 4); until then it picks nothing.
    let Some(Press {
        moved: false,
        item: Some(item),
        generation,
        ..
    }) = press
    else {
        return;
    };
    let Some(tab) = cx.global_mut::<BrowserState>().tabs.iter_mut().find(|t| {
        &t.id == id
            && t.picking
            && t.pick.generation.get() == generation
            && item.data["url"] == t.url.as_str()
    }) else {
        return;
    };
    if let Some(at) = tab.selections.iter().position(|p| {
        p.data["url"] == item.data["url"] && p.data["identity"] == item.data["identity"]
    }) {
        tab.selections.remove(at);
    } else {
        tab.selections.push(item);
    }
    super::changed(id, cx);
}
pub(crate) fn step(id: &TabId, wider: bool, cx: &mut App) {
    let Some(tab) = cx
        .global_mut::<BrowserState>()
        .tabs
        .iter_mut()
        .find(|t| &t.id == id && t.picking && t.pick.down.borrow().is_none())
    else {
        return;
    };
    let Some(hover) = tab.pick_hover.as_mut() else {
        return;
    };
    let new = if wider {
        (hover.index + 1).min(hover.levels.len().saturating_sub(1))
    } else {
        hover.index.saturating_sub(1)
    };
    if new == hover.index {
        return;
    }
    hover.index = new;
    *tab.pick.preferred.borrow_mut() = hover.levels[new].data["identity"]
        .as_str()
        .map(str::to_owned);
    probe::label(hover);
    cx.refresh_windows();
}
#[expect(clippy::cast_possible_truncation, reason = "page wheel deltas fit f32")]
pub(crate) fn wheel(id: &TabId, delta: f64, cx: &mut App) {
    let Some(session) = cx
        .global::<BrowserState>()
        .tab(id)
        .filter(|t| t.picking)
        .map(|t| t.pick.clone())
    else {
        return;
    };
    let v = session.wheel.get() + delta as f32;
    if v.abs() >= 40. {
        session.wheel.set(0.);
        step(id, v > 0., cx);
    } else {
        session.wheel.set(v);
    }
}
