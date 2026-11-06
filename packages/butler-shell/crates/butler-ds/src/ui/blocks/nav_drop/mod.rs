//! DS NavDropTarget (NavDropTarget.tsx, NavDropOverlay.tsx, navDropAutoScroll.ts, with
//! `lib/dropZones.ts`): the drag feedback of a sidebar tree. [`NavDropScope`] wraps the
//! droppable rows, opens a one-row slot where a dragged row would land (the target of a
//! `before` drop and every later row travel down; a 2px accent line sits in the slot), rings the
//! header of an `inside`, `group` or `outside` target, and shows the auto-scroll band at the
//! list's edge. The product owns the drag data and its rules; the block hit-tests the rows on
//! their layout boxes, with the hysteresis and combine dwell of [`zones`].
//!
//! The drag is gpui's own (`on_drag` / `on_drag_move` / `on_drop`); React uses native HTML5
//! drag and `dnd-kit` is not involved. A scope drives a drag of payload type `T` once
//! [`NavDropScope::drag`] gives it the per-row rules (which zones a row takes) and the
//! `canDrop` check; without it the scope only draws what its rows are told (`drop`).
pub mod auto_scroll;
mod overlay;
mod row;
mod scope;
pub mod zones;

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Div, IntoElement, ParentElement as _, SharedString, Stateful,
    StatefulInteractiveElement as _, Styled as _, Window,
};

pub use scope::{DragRules, NavDropScope};
pub use zones::{DropZone, DropZoneHit, DropZoneRules};

/// Row drags: `Before` and `After` open an insert slot, `Inside` and `Group` ring the header.
/// `Outside`: a payload from outside the tree (picked elements, a browser tab) is over the row;
/// a ring and a label, and no row ever moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavDropPosition {
    Before,
    After,
    Inside,
    Group,
    Outside,
}

/// What a drag over the tree carries: `Outside` never moves a row or opens a slot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Payload {
    #[default]
    Rows,
    Outside,
}

type Attach = Box<dyn FnOnce(Stateful<Div>) -> Stateful<Div>>;
type Dwelled = Rc<dyn Fn(&mut Window, &mut App)>;

/// One draggable sidebar tree item and its drop feedback.
pub struct NavDropTarget {
    pub(crate) key: SharedString,
    pub(crate) drop: Option<NavDropPosition>,
    pub(crate) dragging: bool,
    pub(crate) indicator: Option<(f32, f32)>,
    pub(crate) hint: Option<SharedString>,
    pub(crate) invalid: bool,
    pub(crate) on_dwell: Option<Dwelled>,
    pub(crate) dwell: Duration,
    pub(crate) attach: Vec<Attach>,
    pub(crate) child: AnyElement,
}

/// `useDropDwell`'s default: a drag resting on a row this long opens its screen.
const DWELL: Duration = Duration::from_millis(600); // DS: NavDropTarget.tsx:28

impl NavDropTarget {
    /// `key` names the row to the scope's rules and hit.
    pub fn new(key: impl Into<SharedString>, child: impl IntoElement) -> Self {
        Self {
            key: key.into(),
            drop: None,
            dragging: false,
            indicator: None,
            hint: None,
            invalid: false,
            on_dwell: None,
            dwell: DWELL,
            attach: Vec::new(),
            child: child.into_any_element(),
        }
    }

    /// Where a dragged row would land relative to this row, while it hovers. A scope that
    /// drives the drag sets it from its own hit.
    pub fn drop(mut self, drop: Option<NavDropPosition>) -> Self {
        self.drop = drop;
        self
    }

    /// This row is the one being dragged.
    pub fn dragging(mut self, dragging: bool) -> Self {
        self.dragging = dragging;
        self
    }

    /// The row header box inside this item (a folder's children sit below it), in px from the
    /// item's top: the box the group ring covers and the drop zones are tested on. Without it,
    /// the whole item.
    pub fn indicator(mut self, top: f32, height: f32) -> Self {
        self.indicator = Some((top, height));
        self
    }

    /// A short label over the row for `Group` drops ("Group together"), or beside it for
    /// `Outside` drops ("Add to 'Trip'").
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// An `Outside` payload cannot drop here: a dashed danger ring and the reason.
    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// Opens the row's screen when a drag rests on it for `dwell` (default 600 ms), like a
    /// spring-loaded folder. Called once per rest.
    pub fn on_dwell(
        mut self,
        dwell: Option<Duration>,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.dwell = dwell.unwrap_or(DWELL);
        self.on_dwell = Some(Rc::new(handler));
        self
    }

    /// Makes the row draggable with `payload`; `ghost` draws what follows the pointer, and
    /// `on_start` runs when the drag begins.
    pub fn draggable<T: 'static>(
        mut self,
        payload: T,
        ghost: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
        on_start: impl Fn(&mut App) + 'static,
    ) -> Self {
        let ghost: overlay::Ghosting = Rc::new(ghost);
        self.attach.push(Box::new(move |el| {
            el.on_drag(payload, move |_, _, _, cx| {
                on_start(cx);
                let ghost = ghost.clone();
                cx.new(|_| overlay::Ghost(ghost))
            })
        }));
        self
    }
}

/// `NavRootDropZone`: the dashed "move to the top level" zone shown while a row is dragged.
#[derive(IntoElement)]
pub struct NavRootDropZone {
    active: bool,
    label: SharedString,
}

impl NavRootDropZone {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            active: false,
            label: label.into(),
        }
    }

    /// A dragged row is over the zone.
    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }
}

impl gpui::RenderOnce for NavRootDropZone {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        use crate::tokens::{Color, Length};
        use crate::ui::context::Ds;
        use crate::ui::typo::{Tone, Typo};
        let ds = Ds::get(cx);
        let (border, fill) = if self.active {
            (ds.color(Color::Accent), ds.color(Color::Selection))
        } else {
            (ds.color(Color::LineStrong), gpui::transparent_black())
        };
        gpui::div()
            .p(ds.len(Length::SpaceMd))
            .border(ds.len(Length::BorderHairline))
            .border_dashed()
            .border_color(border)
            .rounded(ds.len(Length::RadiusControl))
            .bg(fill)
            .child(Typo::body(self.label).tone(Tone::Secondary))
    }
}
