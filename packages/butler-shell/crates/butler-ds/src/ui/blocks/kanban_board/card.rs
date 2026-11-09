//! KanbanCard (`KanbanCard.tsx`): a card in a KanbanLane. Inside a KanbanDragScope it drags with
//! the pointer or the keyboard (Space, arrows, Space); outside one it is a plain card that opens.
//! The card is a button: click or Enter opens it (`on_open`), Space picks it up. The wrapper owns
//! the focus, the hover fill and the focus ring; the DS Card draws the surface.
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Div, ElementId, InteractiveElement as _,
    IntoElement, ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, canvas, div, px,
};

use super::frame::{self, LaneCtx};
use super::lifted::{Lifted, Preview};
use super::model::{LaneLayout, Rect};
use super::scope::KanbanDrag;
use super::session::{Hub, Mode, Side, begin, card_blur, card_key};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;
use crate::ui::layout::Space;
use crate::ui::{convert, focus};

type OnOpen = Rc<dyn Fn(&mut Window, &mut App)>;

/// A pointer-dragged card stays home as a faint placeholder (`.item[data-lifted="pointer"]`).
const PLACEHOLDER: f32 = 0.42; // DS: KanbanBoard.module.css:154

#[derive(IntoElement)]
pub struct KanbanCard {
    item_id: SharedString,
    label: SharedString,
    on_open: Option<OnOpen>,
    selected: bool,
    disabled: bool,
    preview: Option<Preview>,
    anchor: Option<SharedString>,
    children: Vec<AnyElement>,
}

impl KanbanCard {
    /// `item_id` is stable and reported by `on_move`; `label` names the card in announcements.
    pub fn new(item_id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            item_id: item_id.into(),
            label: label.into(),
            on_open: None,
            selected: false,
            disabled: false,
            preview: None,
            anchor: None,
            children: Vec::new(),
        }
    }

    /// Click or Enter opens the item (Space picks it up).
    pub fn on_open(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// Not draggable (still opens).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// What the lifted copy shows. gpui cannot draw the card's own children twice, so without
    /// this the copy shows `label`.
    pub fn preview(
        mut self,
        preview: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        self.preview = Some(Rc::new(preview));
        self
    }

    /// Names the card for the live harness (`debug_selector`).
    pub fn anchor(mut self, name: impl Into<SharedString>) -> Self {
        self.anchor = Some(name.into());
        self
    }
}

impl ParentElement for KanbanCard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Records the card's box as it paints.
fn recorder(
    hub: &Hub,
    item: &SharedString,
    lane: &SharedString,
    label: &SharedString,
) -> AnyElement {
    let (hub, item, lane, label) = (hub.clone(), item.clone(), lane.clone(), label.clone());
    canvas(
        |bounds: Bounds<Pixels>, _, _| bounds,
        move |_, bounds, _, _| {
            hub.borrow_mut()
                .add_card(item, lane, Rect::of(bounds), label);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// The drop line (`.item[data-drop]`): centered in the gap before or after the card. A grid lane
/// opens no gap row: a vertical line in the column gap.
fn drop_line(side: Side, layout: LaneLayout, ds: &Ds) -> Div {
    // ANIM-MIGRATE(the line fades in and scales in over --motion-base, and a list lane opens a card-sized slot at the anchor)
    let line = ds.len(Length::KanbanDropLine);
    let off = -((Space::Sm.px(ds) + line) / 2.);
    let base = div()
        .absolute()
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Accent));
    match (layout, side) {
        (LaneLayout::List, Side::Before) => base.left_0().right_0().top(off).h(line),
        (LaneLayout::List, Side::After) => base.left_0().right_0().bottom(off).h(line),
        (LaneLayout::Grid, Side::Before) => base.top_0().bottom_0().left(off).w(line),
        (LaneLayout::Grid, Side::After) => base.top_0().bottom_0().right(off).w(line),
    }
}

/// The pointer drag source: the lifted copy follows the pointer once it moves off the card.
fn draggable(el: gpui::Stateful<Div>, hub: &Hub, card: &KanbanCard) -> gpui::Stateful<Div> {
    let (hub, label, preview) = (hub.clone(), card.label.clone(), card.preview.clone());
    let payload = KanbanDrag {
        scope: hub.borrow().id.clone(),
        item: card.item_id.clone(),
    };
    el.on_drag(payload, move |drag, offset, window, cx| {
        begin(&hub, &drag.item, Mode::Pointer, window, cx);
        let width = hub
            .borrow()
            .card_rect(&drag.item)
            .map(|rect| px(rect.width));
        cx.new(|_| Lifted {
            label: label.clone(),
            preview: preview.clone(),
            width,
            offset,
        })
    })
}

/// Space picks the card up (never clicks it); Enter opens it, or drops a lifted card.
fn keyed(
    el: gpui::Stateful<Div>,
    hub: Option<Hub>,
    item: SharedString,
    open: Option<OnOpen>,
    handle: gpui::FocusHandle,
) -> gpui::Stateful<Div> {
    el.on_key_down(move |event, window, cx| {
        if !handle.is_focused(window) {
            return;
        }
        let key = event.keystroke.key.as_str();
        let lifted = hub
            .as_ref()
            .is_some_and(|hub| card_key(hub, &item, key, window, cx));
        let opened = !lifted
            && key == "enter"
            && open.as_ref().is_some_and(|open| {
                open(window, cx);
                true
            });
        if lifted || opened {
            window.prevent_default();
            cx.stop_propagation();
            window.refresh();
        }
    })
}

impl RenderOnce for KanbanCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (hub, lane) = (frame::hub(cx), frame::lane(cx));
        let live = hub
            .clone()
            .zip(lane.clone())
            .filter(|(hub, _)| !self.disabled && !hub.borrow().cfg.disabled)
            .map(|(hub, _)| hub);
        let focusable = live.is_some() || self.on_open.is_some();
        let id: ElementId = (ElementId::from(self.item_id.clone()), "kanban-card").into();
        let handle = window
            .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let focused = focusable && handle.is_focused(window);
        if let Some(hub) = &hub {
            if !focused {
                card_blur(hub, &self.item_id, window, cx);
            }
            if hub.borrow_mut().take_focus(&self.item_id) {
                let target = handle.clone();
                window.defer(cx, move |window, cx| window.focus(&target, cx));
            }
        }
        let view = hub
            .as_ref()
            .map(|hub| hub.borrow().view.clone())
            .unwrap_or_default();
        let lifted = view
            .active
            .as_ref()
            .filter(|active| **active == self.item_id)
            .and(view.mode);
        let side = lane
            .as_ref()
            .and_then(|lane| view.side(&lane.id, Some(&*self.item_id)));
        let tracked = focusable.then_some(&handle);
        let wrap = self.shell(id.clone(), focused, lifted, tracked, cx);
        let wrap = match &live {
            Some(hub) => draggable(wrap, hub, &self),
            None => wrap,
        };
        let wrap = if focusable {
            keyed(
                wrap,
                live,
                self.item_id.clone(),
                self.on_open.clone(),
                handle.clone(),
            )
        } else {
            wrap
        };
        self.assemble(wrap, id, side, lane, hub, cx)
    }
}

impl KanbanCard {
    /// The wrapper (`.item`): focus, ring, lift shadow, placeholder dimming and the click.
    fn shell(
        &self,
        id: ElementId,
        focused: bool,
        lifted: Option<Mode>,
        handle: Option<&gpui::FocusHandle>,
        cx: &mut App,
    ) -> gpui::Stateful<Div> {
        let ds = Ds::get(cx);
        let mut shadows = Vec::new();
        if focus::visible(ds, focused, false) {
            shadows.extend(focus::shadows(ds));
        }
        if lifted == Some(Mode::Keyboard) {
            shadows.extend(convert::box_shadows(
                ds.tokens().shadow(Shadow::ShadowDragLift),
                ds.tokens(),
            ));
        }
        let mut wrap = div()
            .id(id)
            .relative()
            .min_w_0()
            .rounded(ds.len(Length::RadiusControl));
        if !shadows.is_empty() {
            wrap = wrap.shadow(shadows);
        }
        // ANIM-MIGRATE(the card's lift scale/shadow spring on pick-up, and the FLIP glide of cards to their new places on a commit)
        if lifted == Some(Mode::Pointer) {
            wrap = wrap.opacity(PLACEHOLDER);
        }
        if let Some(name) = self.anchor.clone() {
            wrap = wrap.debug_selector(move || name.to_string());
        }
        if let Some(handle) = handle {
            wrap = wrap
                .cursor_pointer()
                .track_focus(&focus::tab_stop(handle, true));
        }
        match &self.on_open {
            Some(open) => {
                let open = open.clone();
                // The keyboard opens through `keyed`; a click is a pointer click.
                wrap.on_click(move |event: &ClickEvent, window, cx| {
                    if !matches!(event, ClickEvent::Keyboard(_)) {
                        open(window, cx);
                    }
                })
            }
            None => wrap,
        }
    }

    /// The surface, the hover fill, the box recorder and the drop line inside the wrapper.
    fn assemble(
        self,
        wrap: gpui::Stateful<Div>,
        id: ElementId,
        side: Option<Side>,
        lane: Option<LaneCtx>,
        hub: Option<Hub>,
        cx: &mut App,
    ) -> gpui::Stateful<Div> {
        let ds = Ds::get(cx);
        let group = SharedString::from(format!("kanban-card-{}", self.item_id));
        let hover = ds.color(Color::Selection);
        let radius = ds.len(Length::RadiusControl);
        let layout = lane.as_ref().map_or(LaneLayout::List, |lane| lane.layout);
        let tint = (self.on_open.is_some() || hub.is_some()).then(|| {
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .rounded(radius)
                .group_hover_style(group.clone(), move |style| style.bg(hover))
        });
        let line = side.map(|side| drop_line(side, layout, ds));
        let record = hub
            .zip(lane)
            .map(|(hub, lane)| recorder(&hub, &self.item_id, &lane.id, &self.label));
        let surface = Card::new((id, "card"))
            .selected(self.selected)
            .padding(CardPadding::Md)
            .children(self.children);
        wrap.group(group)
            .child(surface)
            .children(tint)
            .children(record)
            .children(line)
    }
}
