//! KanbanDragScope (`KanbanDragScope.tsx`): lets cards move between the lanes of every
//! KanbanBoard inside it. A card is dragged by a gpui pointer drag (dnd-kit in React) or by the
//! keyboard (Space, arrows, Space); the scope tracks the pointer, shows where a drop lands and
//! reports the drop. The product owns the order.
//!
//! Not reproduced (`ANIM-MIGRATE`): the slot that opens at the drop point on `--motion-base`
//! (the drop line sits in the gap and no card moves), the cards' FLIP glide and the lifted
//! copy's settle on a drop, the lift spring (`--motion-scale-lift` is 1), the line's fade-in,
//! and the edge-band auto-scroll (a frame loop; `ScrollArea` hands out no scroll handle). The
//! pointer drag starts after gpui's own threshold (React: 6px mouse, 250ms long press touch).
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    Styled as _, Window, div,
};

use super::frame::in_scope;
use super::labels::KanbanDragLabels;
use super::model::KanbanMove;
use super::session::{
    CanDrop, Config, Hub, OnAnnounce, OnMove, Session, finish, pointer_move, settle,
};

/// The payload of a gpui drag: the scope it belongs to and the card's id.
pub(super) struct KanbanDrag {
    pub scope: ElementId,
    pub item: gpui::SharedString,
}

#[derive(IntoElement)]
pub struct KanbanDragScope {
    id: ElementId,
    cfg: Config,
    children: Vec<AnyElement>,
}

impl KanbanDragScope {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            cfg: Config::default(),
            children: Vec::new(),
        }
    }

    /// A card was dropped somewhere new: the same lane (reorder), another lane or another board.
    /// Apply it (optimistically) and persist; to reject, leave or restore the order.
    pub fn on_move(
        mut self,
        handler: impl Fn(KanbanMove, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.cfg.on_move = Some(Rc::new(handler) as OnMove);
        self
    }

    /// Lanes that may take `item_id`; others neither highlight nor take the drop. Default: all.
    pub fn can_drop(mut self, can_drop: impl Fn(&str, &str) -> bool + 'static) -> Self {
        self.cfg.can_drop = Some(Rc::new(can_drop) as CanDrop);
        self
    }

    /// Localized announcements; English by default.
    pub fn labels(mut self, labels: KanbanDragLabels) -> Self {
        self.cfg.labels = labels;
        self
    }

    /// Receives each announcement of a drag (gpui has no live region).
    pub fn on_announce(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.cfg.on_announce = Some(Rc::new(handler) as OnAnnounce);
        self
    }

    /// Lock every card in place (a read-only board).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.cfg.disabled = disabled;
        self
    }
}

impl ParentElement for KanbanDragScope {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Wires the pointer handlers onto the scope's element: every move retargets, a drop commits.
fn tracked(
    root: gpui::Stateful<gpui::Div>,
    hub: &Hub,
    id: &ElementId,
) -> gpui::Stateful<gpui::Div> {
    let (moving, dropping) = (hub.clone(), hub.clone());
    let (scope, dropped) = (id.clone(), id.clone());
    root.on_drag_move::<KanbanDrag>(move |event, window, cx| {
        if event.drag(cx).scope != scope {
            return;
        }
        let (x, y) = (
            event.event.position.x.as_f32(),
            event.event.position.y.as_f32(),
        );
        if pointer_move(&moving, x, y) {
            window.refresh();
        }
    })
    .on_drop::<KanbanDrag>(move |drag, window, cx| {
        if drag.scope == dropped {
            finish(&dropping, true, window, cx);
            window.refresh();
        }
    })
}

impl RenderOnce for KanbanDragScope {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // ANIM-MIGRATE(auto-scroll of the board, lane and page while the pointer rests in a 40px edge band; needs a frame loop and a ScrollArea scroll handle)
        let id = self.id.clone();
        let hub = window
            .use_keyed_state((id.clone(), "hub"), cx, |_, _| {
                Rc::new(RefCell::new(Session::new(id.clone())))
            })
            .read(cx)
            .clone();
        hub.borrow_mut().cfg = self.cfg;
        settle(&hub, window, cx);
        let root = div()
            .id((id.clone(), "scope"))
            .w_full()
            .min_w_0()
            .children(self.children);
        in_scope(hub.clone(), tracked(root, &hub, &id))
    }
}
