//! DS StepSortableList (`libs/design-system/blocks/StepSortableList/`): ordered chains of steps
//! (a head, then its follow-ups) with drag reordering. Drop between steps for a new step, rest
//! on a step (250 ms) to join its 묶음, move between chains, drag out of an open 묶음 to split
//! it. Pointer drags start on a card or its grip (gpui's own drag: `on_drag`, `on_drag_move`,
//! `on_drop`; React uses dnd-kit); the keyboard drags from the grip. The block reports semantic
//! edits ([`StepSortableEdit`]); the product owns the order and applies them with
//! [`apply_step_sortable_edit`].
//!
//! Not reproduced: the screen-reader live region (announcements go to `on_announce`), the
//! deck's accessible names, the slide of a 묶음 opening and the `lift-in` shadow fade, the
//! focus ring staying opaque on a dimmed lifted step, Escape cancelling a pointer drag (gpui
//! ends it on release), and the 4 px / 180 ms drag activation (gpui starts a drag after 2 px).
mod deck;
mod grip;
mod labels;
mod lifted;
mod model;
mod row;
mod session;
mod step;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, ScrollHandle, SharedString, Styled as _, Window, div,
};

use grip::{StepDrag, grip_handle};
pub use labels::StepSortableLabels;
pub use model::{
    StepSortableChain, StepSortableEdit, StepSortableEditKind, StepSortableItem, StepSortablePlace,
    StepSortablePlacement, StepSortableTarget, StepSortableTargetKind, apply_step_sortable_edit,
};
pub use session::STEP_SORTABLE_JOIN_DWELL;
use session::{
    Config, DragView, Hub, Mode, finish, item_drag_id, pointer_update, step_drag_id, tick,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::typo::{Tone, Typo};

/// What a drop does now, for the lifted copy's caption (함께 진행 / 새 단계로).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepSortableOutcome {
    Join,
    NewStep,
}

/// Where a row sits, for the product's row content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepSortableRowContext {
    pub chain_id: SharedString,
    /// 0-based step index in the chain (0: the chain's head).
    pub step_index: usize,
    /// 1-based step number.
    pub step_number: usize,
    /// Items in the row's step (two or more: a 묶음; the collapsed front says “외 N건”).
    pub count: usize,
    /// A card of an open 묶음 (a full-width row in the 묶음's column; no `more`, the number on its
    /// first card only).
    pub expanded: bool,
    /// The lifted copy under the pointer.
    pub lifted: bool,
    /// On the lifted copy: what a drop does now, for its caption.
    pub outcome: Option<StepSortableOutcome>,
}

/// A row's content slots; the block adds the grip in front and the card around it.
#[derive(Default)]
pub struct StepSortableRowSlots {
    /// Step number or status glyph, in the leading icon slot.
    pub marker: Option<AnyElement>,
    pub title: SharedString,
    /// How many more a collapsed 묶음 holds (ko: 외 N건), right after the title; the title
    /// truncates, this never does.
    pub more: Option<SharedString>,
    /// Short status after the title, at the end of the title line (진행 중 · 12분, 대기, 멈춤).
    pub meta: Option<SharedString>,
    /// One read-only line under the title (progress, or “<previous> 끝나면”).
    pub caption: Option<SharedString>,
    /// Trailing control (an OverflowActionMenu); a row without one keeps its room so statuses
    /// line up.
    pub trailing: Option<AnyElement>,
}

/// A static drag state (the items lifted over a target) for previews and docs; no live drag runs.
#[derive(Clone, Debug)]
pub struct StepSortableDragPreview {
    pub item_ids: Vec<SharedString>,
    pub target: StepSortableTarget,
}

/// Row content for an item (`renderItem`); the block draws the card, the grip and the deck. The
/// product looks its own data up by the item's id.
pub type RenderItem = Rc<
    dyn Fn(
        &StepSortableItem,
        &StepSortableRowContext,
        &mut Window,
        &mut App,
    ) -> StepSortableRowSlots,
>;

/// What one frame of the list is built from.
struct Env {
    id: ElementId,
    hub: Rc<Hub>,
    render_item: RenderItem,
    labels: StepSortableLabels,
    disabled: bool,
    fanned: HashSet<SharedString>,
    view: DragView,
    heights: HashMap<SharedString, f32>,
}

impl Env {
    fn from_hub(id: &ElementId, hub: &Rc<Hub>, render_item: &RenderItem) -> Self {
        let session = hub.borrow();
        Self {
            id: id.clone(),
            hub: hub.clone(),
            render_item: render_item.clone(),
            labels: session.cfg.labels.clone(),
            disabled: session.cfg.disabled,
            fanned: session.fanned.clone(),
            view: session.view.clone(),
            heights: session.heights.clone(),
        }
    }
}

/// A child id of `id`: `(id, tag, key)`.
fn sub(id: &ElementId, tag: &'static str, key: &str) -> ElementId {
    let tagged: ElementId = (id.clone(), tag).into();
    (tagged, SharedString::from(key.to_owned())).into()
}

#[derive(IntoElement)]
pub struct StepSortableList {
    id: ElementId,
    chains: Vec<StepSortableChain>,
    render_item: RenderItem,
    cfg: Config,
    preview: Option<StepSortableDragPreview>,
}

impl StepSortableList {
    /// Ordered `chains`; each step is one item or a flat 묶음 (two or more, shown as a deck).
    /// `render_item` maps an item to its row slots.
    pub fn new(
        id: impl Into<ElementId>,
        chains: Vec<StepSortableChain>,
        render_item: impl Fn(
            &StepSortableItem,
            &StepSortableRowContext,
            &mut Window,
            &mut App,
        ) -> StepSortableRowSlots
        + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            chains,
            render_item: Rc::new(render_item),
            cfg: Config::default(),
            preview: None,
        }
    }

    /// A drop or keyboard move made an edit. Apply it (optimistically,
    /// [`apply_step_sortable_edit`]) and persist. Indexes are places before the edit.
    pub fn on_edit(
        mut self,
        handler: impl Fn(&StepSortableEdit, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.cfg.on_edit = Some(Rc::new(handler));
        self
    }

    /// Edits the product accepts; refused targets show no feedback and take no drop. Default: all.
    pub fn can_drop(mut self, accept: impl Fn(&StepSortableEdit) -> bool + 'static) -> Self {
        self.cfg.can_drop = Some(Rc::new(accept));
        self
    }

    /// Localized announcements and grip names; English by default.
    pub fn labels(mut self, labels: StepSortableLabels) -> Self {
        self.cfg.labels = labels;
        self
    }

    /// Receives each announcement (pick-up, every keyboard step, the drop, a cancel).
    pub fn on_announce(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.cfg.on_announce = Some(Rc::new(handler));
        self
    }

    /// Lock every row in place (read-only list).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.cfg.disabled = disabled;
        self
    }

    /// The pane's own scroller: a drag auto-scrolls it near its top and bottom 12%.
    pub fn scroll(mut self, handle: ScrollHandle) -> Self {
        self.cfg.scroll = Some(handle);
        self
    }

    /// A static drag state for previews and docs.
    pub fn drag_preview(mut self, preview: StepSortableDragPreview) -> Self {
        self.preview = Some(preview);
        self
    }
}

/// A drag ended outside the list is a cancel; a keyboard drag whose grip lost focus is too.
fn settle(hub: &Hub, id: &ElementId, window: &mut Window, cx: &mut App) {
    let (mode, active) = {
        let session = hub.borrow();
        (session.view.mode, session.view.active_id.clone())
    };
    match (mode, active) {
        (Some(Mode::Pointer), _) if !cx.has_active_drag() => finish(hub, false, window, cx),
        (Some(Mode::Pointer), _) => tick(hub, window),
        (Some(Mode::Keyboard), Some(drag_id))
            if !grip_handle(id, &drag_id, window, cx).is_focused(window) =>
        {
            finish(hub, false, window, cx);
        }
        _ => {}
    }
}

/// After a keyboard drop, focus follows the moved items to their new place: the item's grip, else
/// the grip (or toggle) of the step that now holds it. It waits for the product to apply the edit.
fn restore_focus(hub: &Hub, id: &ElementId, window: &mut Window, cx: &mut App) {
    let target = {
        let session = hub.borrow();
        let Some((item_id, before)) = session.focus_request.clone() else {
            return;
        };
        if *session.chains == *before {
            return;
        }
        let Some(at) = model::locate_item(&session.chains, &item_id) else {
            return;
        };
        let first = session.chains[at.chain].steps[at.step][0].id.clone();
        let (item, whole) = (item_drag_id(&item_id), step_drag_id(&first));
        if session.rendered.contains(&item) {
            grip::grip_id(id, &item)
        } else if session.rendered.contains(&whole) {
            grip::grip_id(id, &whole)
        } else {
            sub(id, "card", &first)
        }
    };
    hub.borrow_mut().focus_request = None;
    let handle = window
        .use_keyed_state((target, "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    window.defer(cx, move |window, cx| handle.focus(window, cx));
}

fn chain_view(
    env: &Env,
    chain: &StepSortableChain,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let gap_at = |index: usize, cx: &App| {
        let on = env.view.target.as_ref().is_some_and(|target| {
            target.kind == StepSortableTargetKind::Gap
                && target.chain_id == chain.id
                && target.step_index == index
        });
        on.then(|| step::gap(index > 0, cx))
    };
    let mut steps = Vec::new();
    for (index, items) in chain.steps.iter().enumerate() {
        steps.extend(gap_at(index, cx));
        steps.push(step::step(env, chain, items, index, window, cx));
    }
    steps.extend(gap_at(chain.steps.len(), cx));
    let ds = Ds::get(cx);
    let title = chain
        .title
        .clone()
        .map(|title| Typo::caption(title).tone(Tone::Secondary).truncate());
    div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::SpaceSm))
        .children(title)
        .child(
            div()
                .flex()
                .flex_col()
                .w_full()
                .min_w_0()
                .gap(ds.len(Length::SpaceSm))
                .children(steps),
        )
        .into_any_element()
}

impl RenderOnce for StepSortableList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let hub = window
            .use_keyed_state((self.id.clone(), "hub"), cx, |_, _| Rc::new(Hub::default()))
            .read(cx)
            .clone();
        {
            let mut session = hub.borrow_mut();
            session.chains = Rc::new(self.chains);
            session.cfg = self.cfg;
            session.rendered.clear();
        }
        settle(&hub, &self.id, window, cx);
        let mut env = Env::from_hub(&self.id, &hub, &self.render_item);
        if let Some(preview) = self.preview {
            env.view = DragView {
                active_id: preview
                    .item_ids
                    .first()
                    .map(|id| format!("preview:{id}").into()),
                item_ids: preview.item_ids,
                mode: Some(Mode::Preview),
                target: Some(preview.target),
            };
        }
        let chains = hub.borrow().chains.clone();
        let views: Vec<AnyElement> = chains
            .iter()
            .map(|chain| chain_view(&env, chain, window, cx))
            .collect();
        restore_focus(&hub, &self.id, window, cx);
        let gap = Ds::get(cx).len(Length::Space4);
        let (moving, dropping, list) = (hub.clone(), hub, self.id.clone());
        let dropped = list.clone();
        div()
            .id((self.id, "list"))
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(gap)
            .on_drag_move::<StepDrag>(move |event, window, cx| {
                if event.drag(cx).list == list {
                    pointer_update(&moving, event.event.position.y.as_f32());
                    window.refresh();
                }
            })
            .on_drop::<StepDrag>(move |drag, window, cx| {
                if drag.list == dropped {
                    finish(&dropping, true, window, cx);
                    window.refresh();
                }
            })
            .children(views)
    }
}
