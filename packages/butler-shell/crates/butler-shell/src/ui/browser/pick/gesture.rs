//! BrowserSelection's press/hit/settle state machine. A hit can finish after movement or release.
use super::{
    Hover, Item, Session,
    geometry::{contains, n, rect},
    input, probe,
};
use crate::ui::browser::{engine::TabId, model::BrowserState};
use gpui::{AnyWindowHandle, App, Modifiers, Window};

#[derive(Clone)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent states of the Electron press/hit/settle gesture"
)]
pub(super) struct Press {
    serial: u64,
    x: f64,
    y: f64,
    at: (f64, f64),
    alt: bool,
    on_pick: bool,
    moved: bool,
    area: Option<bool>,
    ended: bool,
    ready: bool,
    item: Option<Item>,
    window: AnyWindowHandle,
    origin: gpui::Point<gpui::Pixels>,
}
#[derive(Clone, Copy)]
pub(crate) enum Mouse {
    Move,
    Leave,
    Down,
    Up,
}
pub(crate) fn mouse(
    id: &TabId,
    x: f64,
    y: f64,
    modifiers: Modifiers,
    kind: Mouse,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some(tab) = cx
        .global::<BrowserState>()
        .tab(id)
        .filter(|t| t.picking)
        .cloned()
    else {
        return false;
    };
    let session = tab.pick.clone();
    session.point.set(Some((x, y)));
    match kind {
        Mouse::Down => {
            session.press_id.set(session.press_id.get() + 1);
            let press = Press::new(&tab, x, y, modifiers, window);
            *session.down.borrow_mut() = Some(press.clone());
            hit(id, press.serial, &session, cx);
        }
        Mouse::Move | Mouse::Up => {
            let mut down = session.down.borrow_mut();
            if let Some(press) = down.as_mut() {
                press.at = (x, y);
                if !press.moved && (x - press.x).hypot(y - press.y) > 6. {
                    press.moved = true;
                    press.area = if press.alt {
                        Some(true)
                    } else if press.on_pick {
                        Some(false)
                    } else if press.ready {
                        Some(press.item.is_none())
                    } else {
                        None
                    };
                }
                press.ended = matches!(kind, Mouse::Up);
            } else if matches!(kind, Mouse::Move) {
                input::hover(id, x, y, cx);
            }
            drop(down);
            settle(id, &session, cx);
        }
        Mouse::Leave => {
            if session.down.borrow().is_none() {
                session.point.set(None);
                session.revision.set(session.revision.get() + 1);
                show(id, None, cx);
            }
        }
    }
    true
}
fn hit(id: &TabId, serial: u64, session: &Session, cx: &mut App) {
    let id = id.clone();
    let session = session.clone();
    let point = session.point.get().unwrap_or_default();
    let preferred = session.preferred.borrow().clone();
    let generation = session.generation.get();
    cx.spawn(async move |cx| {
        let result = async {
            let hover = probe::probe(&id, point.0, point.1, preferred.as_deref(), cx).await?;
            probe::hit(&id, &hover, cx).await
        }
        .await;
        cx.update(|cx| {
            if session.generation.get() != generation {
                return;
            }
            if let Some(press) = session
                .down
                .borrow_mut()
                .as_mut()
                .filter(|p| p.serial == serial)
            {
                press.item = result.ok();
                press.ready = true;
                if press.moved && press.area.is_none() {
                    press.area = Some(press.item.is_none());
                }
            }
            settle(&id, &session, cx);
        });
    })
    .detach();
}
fn show(id: &TabId, hover: Option<Hover>, cx: &mut App) {
    if let Some(tab) = cx
        .global_mut::<BrowserState>()
        .tabs
        .iter_mut()
        .find(|t| &t.id == id)
    {
        tab.pick_hover = hover;
    }
    cx.refresh_windows();
}
fn settle(id: &TabId, session: &Session, cx: &mut App) {
    let Some(press) = session.down.borrow().clone() else {
        return;
    };
    if press.area == Some(true) {
        area(id, session, &press, cx);
        return;
    }
    if press.moved && press.on_pick {
        session.down.borrow_mut().take();
        drag(id, &press, cx);
        return;
    }
    if !press.ready || (!press.moved && !press.ended) {
        return;
    }
    session.down.borrow_mut().take();
    let Some(item) = press.item.clone() else {
        return;
    };
    let Some(tab) = cx
        .global_mut::<BrowserState>()
        .tabs
        .iter_mut()
        .find(|t| &t.id == id && t.picking)
    else {
        return;
    };
    if let Some(index) = tab.selections.iter().position(|p| {
        p.data["identity"] == item.data["identity"] && p.data["url"] == item.data["url"]
    }) {
        if !press.moved {
            tab.selections.remove(index);
        }
    } else {
        tab.selections.push(item);
    }
    super::follow::sync(id, cx);
    if press.moved {
        drag(id, &press, cx);
    }
    cx.refresh_windows();
}
fn area(id: &TabId, session: &Session, press: &Press, cx: &mut App) {
    let rect = rect(
        press.x.min(press.at.0),
        press.y.min(press.at.1),
        (press.at.0 - press.x).abs(),
        (press.at.1 - press.y).abs(),
    );
    show(
        id,
        Some(Hover {
            levels: Vec::new(),
            index: 0,
            label: format!("{:.0} × {:.0}", n(&rect, "width"), n(&rect, "height")),
            rect: rect.clone(),
        }),
        cx,
    );
    if !press.ended {
        return;
    }
    session.down.borrow_mut().take();
    show(id, None, cx);
    let generation = session.generation.get();
    let id = id.clone();
    cx.spawn(async move |cx| {
        let item = super::crop::area(&id, rect, cx).await;
        cx.update(|cx| {
            if let Ok(item) = item
                && let Some(tab) = cx
                    .global_mut::<BrowserState>()
                    .tabs
                    .iter_mut()
                    .find(|t| t.id == id && t.pick.generation.get() == generation)
            {
                tab.selections.push(item);
            }
            super::follow::sync(&id, cx);
            cx.refresh_windows();
        });
    })
    .detach();
}
fn drag(id: &TabId, press: &Press, cx: &mut App) {
    let items = cx
        .global::<BrowserState>()
        .tab(id)
        .map(|t| t.selections.clone())
        .unwrap_or_default();
    super::drag::start(items, cx);
    if press.ended {
        let _ = press.window.update(cx, |_, window, cx| {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "CSS pointer coordinates fit f32"
            )]
            let position = press.origin
                + gpui::point(gpui::px(press.at.0 as f32), gpui::px(press.at.1 as f32));
            window.dispatch_event(
                gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                    button: gpui::MouseButton::Left,
                    position,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                }),
                cx,
            );
        });
    }
}

impl Press {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "viewport pointer coordinates fit f32"
    )]
    fn new(
        tab: &crate::ui::browser::model::Tab,
        x: f64,
        y: f64,
        modifiers: Modifiers,
        window: &Window,
    ) -> Self {
        Self {
            serial: tab.pick.press_id.get(),
            x,
            y,
            at: (x, y),
            alt: modifiers.alt,
            on_pick: tab
                .selections
                .iter()
                .any(|p| !p.hidden && contains(&p.data["rect"], x, y)),
            moved: false,
            area: None,
            ended: false,
            ready: false,
            item: None,
            window: window.window_handle(),
            origin: window.mouse_position() - gpui::point(gpui::px(x as f32), gpui::px(y as f32)),
        }
    }
}
