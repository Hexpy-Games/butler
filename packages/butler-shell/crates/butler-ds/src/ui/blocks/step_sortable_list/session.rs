//! The drag session of a StepSortableList (`useStepSortableDrag.ts`): the view, the step boxes
//! frozen when a drag starts, and starting, retargeting and finishing a drag, by pointer or
//! keyboard. The state lives in one [`Hub`] kept in the list's window state; handlers borrow it
//! briefly and call the product's callbacks only after the borrow ends.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{App, Bounds, Pixels, ScrollHandle, SharedString, Window, point, px};

use super::labels::StepSortableLabels;
use super::model::{
    StepSortableChain, StepSortableEdit, StepSortableTarget, StepSortableTargetKind, edit_for,
    is_draggable, is_pinned_step, keyboard_targets, locate_item, result_place,
};
use crate::ui::blocks::nav_drop::auto_scroll;
use crate::ui::blocks::nav_drop::zones::{
    DropZone, DropZoneBox, DropZoneCandidate, DropZoneRules, DropZoneTracker,
};

/// How long the pointer rests on a step before a drop joins its 묶음.
pub const STEP_SORTABLE_JOIN_DWELL: Duration = Duration::from_millis(250); // DS: useStepSortableDrag.ts:10
/// Share of the scroller's height at its top and bottom where a drag auto-scrolls.
const AUTO_SCROLL_BAND: f32 = 0.12; // DS: stepSortableFocus.ts:34

pub(super) type OnEdit = Rc<dyn Fn(&StepSortableEdit, &mut Window, &mut App)>;
pub(super) type CanDrop = Rc<dyn Fn(&StepSortableEdit) -> bool>;
pub(super) type OnAnnounce = Rc<dyn Fn(&str, &mut Window, &mut App)>;
pub(super) type Hub = RefCell<Session>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Pointer,
    Keyboard,
    Preview,
}

/// What is being dragged and where a drop would go.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct DragView {
    /// Drag id: `item:<id>` (one item) or `step:<first id>` (a collapsed 묶음 as one step).
    pub active_id: Option<SharedString>,
    pub item_ids: Vec<SharedString>,
    pub mode: Option<Mode>,
    /// Where a drop would go; `None` when it would leave the items where they are (or is refused).
    pub target: Option<StepSortableTarget>,
}

pub(super) fn item_drag_id(item_id: &str) -> SharedString {
    format!("item:{item_id}").into()
}

pub(super) fn step_drag_id(first_item_id: &str) -> SharedString {
    format!("step:{first_item_id}").into()
}

/// The key of a step in the box maps.
pub(super) fn step_key(chain_id: &str, step_index: usize) -> SharedString {
    format!("{chain_id}\u{0}{step_index}").into()
}

#[derive(Default)]
pub(super) struct Config {
    pub labels: StepSortableLabels,
    pub on_edit: Option<OnEdit>,
    pub can_drop: Option<CanDrop>,
    pub on_announce: Option<OnAnnounce>,
    pub disabled: bool,
    pub scroll: Option<ScrollHandle>,
}

/// The step boxes in layout position, frozen when the drag starts (the gap line added later never
/// moves the zones).
#[derive(Default)]
struct Frozen {
    steps: HashMap<SharedString, (SharedString, usize)>,
    rows: Vec<DropZoneCandidate<SharedString>>,
    scroll: f32,
}

pub(super) struct Session {
    pub cfg: Config,
    pub chains: Rc<Vec<StepSortableChain>>,
    /// Open 묶음 by first item id: they take gaps only, no joins.
    pub fanned: HashSet<SharedString>,
    pub view: DragView,
    /// Step boxes as last painted, and their heights frozen at drag start (the join ring's).
    pub boxes: HashMap<SharedString, Bounds<Pixels>>,
    pub heights: HashMap<SharedString, f32>,
    /// Drag ids of the grips drawn this frame.
    pub rendered: HashSet<SharedString>,
    pub focus_request: Option<(SharedString, Rc<Vec<StepSortableChain>>)>,
    frozen: Frozen,
    tracker: DropZoneTracker<SharedString>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            cfg: Config::default(),
            chains: Rc::new(Vec::new()),
            fanned: HashSet::new(),
            view: DragView::default(),
            boxes: HashMap::new(),
            heights: HashMap::new(),
            rendered: HashSet::new(),
            focus_request: None,
            frozen: Frozen::default(),
            tracker: DropZoneTracker::with_dwell(STEP_SORTABLE_JOIN_DWELL),
        }
    }
}

/// The items a drag id carries, its announced name, and whether it may move at all.
struct Payload {
    at: super::model::Location,
    item_ids: Vec<SharedString>,
    label: String,
    movable: bool,
}

fn payload_of(
    chains: &[StepSortableChain],
    drag_id: &str,
    labels: &StepSortableLabels,
) -> Option<Payload> {
    let (kind, id) = drag_id.split_once(':')?;
    let at = locate_item(chains, id)?;
    let step = &chains[at.chain].steps[at.step];
    if kind == "step" {
        return Some(Payload {
            at,
            item_ids: step.iter().map(|item| item.id.clone()).collect(),
            label: (labels.stack)(&step[0].label, step.len()),
            movable: !is_pinned_step(step),
        });
    }
    let item = &step[at.item];
    Some(Payload {
        at,
        item_ids: vec![item.id.clone()],
        label: item.label.to_string(),
        movable: is_draggable(item),
    })
}

impl Session {
    fn scroll_y(&self) -> f32 {
        self.cfg
            .scroll
            .as_ref()
            .map_or(0., |handle| handle.offset().y.as_f32())
    }

    /// The edit for `target`, or `None` when the drop changes nothing or is refused.
    fn edit(
        &self,
        item_ids: &[SharedString],
        target: &StepSortableTarget,
    ) -> Option<StepSortableEdit> {
        edit_for(&self.chains, item_ids, target)
            .filter(|edit| self.cfg.can_drop.as_ref().is_none_or(|can| can(edit)))
    }

    fn retarget(&mut self, target: Option<StepSortableTarget>) -> bool {
        let next = target.filter(|target| {
            self.view.active_id.is_some() && self.edit(&self.view.item_ids, target).is_some()
        });
        if self.view.target == next {
            return false;
        }
        self.view.target = next;
        true
    }

    /// Measures the steps (`measureSteps`). The dragged step itself is left out unless an item
    /// leaves its 묶음 (then it takes gaps only); open 묶음 take gaps only.
    fn freeze(&mut self, item_ids: &[SharedString]) {
        let chains = self.chains.clone();
        let mut frozen = Frozen {
            scroll: self.scroll_y(),
            ..Frozen::default()
        };
        self.heights.clear();
        for chain in chains.iter() {
            for (index, step) in chain.steps.iter().enumerate() {
                let key = step_key(&chain.id, index);
                let Some(bounds) = self.boxes.get(&key) else {
                    continue;
                };
                let (top, height) = (bounds.top().as_f32(), bounds.size.height.as_f32());
                self.heights.insert(key.clone(), height);
                let own = step.iter().any(|item| item.id == item_ids[0]);
                if own && item_ids.len() == step.len() {
                    continue;
                }
                frozen.steps.insert(key.clone(), (chain.id.clone(), index));
                frozen.rows.push(DropZoneCandidate {
                    key,
                    bounds: DropZoneBox { top, height },
                    rules: DropZoneRules {
                        combine: !own && !self.fanned.contains(&step[0].id),
                        after: true,
                    },
                });
            }
        }
        self.frozen = frozen;
    }

    /// Where a pointer hit drops: before/after a step is a gap, its middle (after the dwell)
    /// joins it.
    fn sync_target(&mut self) -> bool {
        let target = self.tracker.current().and_then(|hit| {
            let (chain_id, index) = self.frozen.steps.get(&hit.key)?;
            let (step_index, kind) = match hit.zone {
                DropZone::Combine => (*index, StepSortableTargetKind::Join),
                DropZone::Before => (*index, StepSortableTargetKind::Gap),
                DropZone::After => (index + 1, StepSortableTargetKind::Gap),
            };
            Some(StepSortableTarget {
                chain_id: chain_id.clone(),
                step_index,
                kind,
            })
        });
        self.retarget(target)
    }

    fn is_fanned_step(&self, target: &StepSortableTarget) -> bool {
        self.chains
            .iter()
            .find(|chain| chain.id == target.chain_id)
            .and_then(|chain| chain.steps.get(target.step_index))
            .and_then(|step| step.first())
            .is_some_and(|first| self.fanned.contains(&first.id))
    }
}

/// Tells the product (`on_announce`) what a screen reader would be told.
fn say(hub: &Hub, text: &str, window: &mut Window, cx: &mut App) {
    let handler = hub.borrow().cfg.on_announce.clone();
    if let Some(handler) = handler {
        handler(text, window, cx);
    }
}

pub(super) fn set_fanned(hub: &Hub, first_item_id: &SharedString, open: bool) {
    let mut session = hub.borrow_mut();
    if open {
        session.fanned.insert(first_item_id.clone());
    } else {
        session.fanned.remove(first_item_id);
    }
}

/// Starts a drag of `drag_id`; false when it may not move or another drag runs.
pub(super) fn begin(
    hub: &Hub,
    drag_id: &SharedString,
    mode: Mode,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let text = {
        let mut session = hub.borrow_mut();
        let Some(payload) = payload_of(&session.chains, drag_id, &session.cfg.labels) else {
            return false;
        };
        if !payload.movable || session.cfg.disabled || session.view.active_id.is_some() {
            return false;
        }
        session.freeze(&payload.item_ids);
        session.focus_request = None;
        let chain = &session.chains[payload.at.chain];
        let text = (session.cfg.labels.lifted)(&payload.label, &chain.label, payload.at.step + 1);
        session.view = DragView {
            active_id: Some(drag_id.clone()),
            item_ids: payload.item_ids,
            mode: Some(mode),
            target: None,
        };
        text
    };
    if mode == Mode::Pointer {
        pointer_update(hub, window.mouse_position().y.as_f32());
    }
    say(hub, &text, window, cx);
    true
}

/// A pointer move at window `y` against the frozen step boxes.
pub(super) fn pointer_update(hub: &Hub, y: f32) {
    let mut session = hub.borrow_mut();
    if session.view.mode != Some(Mode::Pointer) {
        return;
    }
    let scrolled = session.scroll_y() - session.frozen.scroll;
    let rows = session
        .frozen
        .rows
        .iter()
        .map(|row| {
            let mut row = row.clone();
            row.bounds.top += scrolled;
            row
        })
        .collect();
    session.tracker.update(y, rows, Instant::now());
    session.sync_target();
}

/// One frame of a pointer drag: lets a join dwell commit without a further move, and scrolls the
/// list's own pane when the pointer is in its top or bottom band.
pub(super) fn tick(hub: &Hub, window: &mut Window) {
    let mut session = hub.borrow_mut();
    if session.tracker.waiting() {
        session.tracker.poll(Instant::now());
        session.sync_target();
        window.request_animation_frame();
    }
    if let Some(handle) = session.cfg.scroll.clone() {
        scroll_pane(&handle, window.mouse_position().y.as_f32());
        window.request_animation_frame();
    }
}

fn scroll_pane(handle: &ScrollHandle, y: f32) {
    let bounds = handle.bounds();
    let (top, bottom) = (bounds.top().as_f32(), bounds.bottom().as_f32());
    let step = auto_scroll::step(y, top, bottom, (bottom - top) * AUTO_SCROLL_BAND);
    let offset = handle.offset();
    let scrolled = -offset.y.as_f32();
    let max = handle.max_offset().y.as_f32();
    let room = if step < 0. {
        scrolled > 0.
    } else {
        scrolled < max
    };
    if step != 0. && room {
        let next = (scrolled + step).clamp(0., max);
        handle.set_offset(point(offset.x, px(-next)));
    }
}

/// Ends the drag: a drop makes the edit (when it changes anything), a cancel leaves everything.
pub(super) fn finish(hub: &Hub, drop: bool, window: &mut Window, cx: &mut App) {
    let (change, text) = {
        let mut session = hub.borrow_mut();
        let view = std::mem::take(&mut session.view);
        session.tracker.reset();
        let Some(active) = view.active_id.clone() else {
            return;
        };
        let Some(payload) = payload_of(&session.chains, &active, &session.cfg.labels) else {
            return;
        };
        let labels = session.cfg.labels.clone();
        let change = drop
            .then(|| {
                view.target
                    .as_ref()
                    .and_then(|target| session.edit(&view.item_ids, target))
            })
            .flatten();
        let text = match &change {
            _ if !drop => Some((labels.cancelled)(&payload.label)),
            None => Some((labels.unchanged)(&payload.label)),
            Some(change) => {
                if view.mode == Some(Mode::Keyboard) {
                    session.focus_request = view
                        .item_ids
                        .first()
                        .map(|id| (id.clone(), session.chains.clone()));
                }
                result_place(&session.chains, change)
                    .map(|(chain, step)| (labels.dropped)(&payload.label, &chain, step))
            }
        };
        (change, text)
    };
    let on_edit = hub.borrow().cfg.on_edit.clone();
    if let (Some(change), Some(on_edit)) = (change, on_edit) {
        on_edit(&change, window, cx);
    }
    if let Some(text) = text {
        say(hub, &text, window, cx);
    }
}

/// The next place a keyboard drag visits in `direction`, and what it announces.
fn keyboard_step(session: &mut Session, direction: isize) -> Option<String> {
    let active = session.view.active_id.clone()?;
    let payload = payload_of(&session.chains, &active, &session.cfg.labels)?;
    let all = keyboard_targets(&session.chains);
    let own = StepSortableTarget {
        chain_id: session.chains[payload.at.chain].id.clone(),
        step_index: payload.at.step,
        kind: StepSortableTargetKind::Join,
    };
    let here = session.view.target.clone().unwrap_or(own);
    let mut index = all
        .iter()
        .position(|candidate| *candidate == here)
        .and_then(|at| isize::try_from(at).ok())
        .unwrap_or(-1);
    loop {
        index += direction;
        let candidate = all.get(usize::try_from(index).ok()?)?;
        // Open 묶음 take gaps only, as with the pointer.
        let visits =
            candidate.kind == StepSortableTargetKind::Gap || !session.is_fanned_step(candidate);
        let change = if visits {
            session.edit(&session.view.item_ids, candidate)
        } else {
            None
        };
        let Some(change) = change else {
            continue;
        };
        if !session.retarget(Some(candidate.clone())) {
            continue;
        }
        let (chain, step) = result_place(&session.chains, &change)?;
        let labels = &session.cfg.labels;
        let announce = if candidate.kind == StepSortableTargetKind::Join {
            &labels.join
        } else {
            &labels.new_step
        };
        return Some(announce(&payload.label, &chain, step));
    }
}

/// A key on a grip: Space or Enter lifts, Up/Down visit gaps and steps, Space or Enter drops,
/// Escape cancels. True when the drag handled it.
pub(super) fn grip_key(
    hub: &Hub,
    drag_id: &SharedString,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let current = hub.borrow().view.clone();
    if !(current.mode == Some(Mode::Keyboard) && current.active_id.as_ref() == Some(drag_id)) {
        return matches!(key, "space" | "enter") && begin(hub, drag_id, Mode::Keyboard, window, cx);
    }
    match key {
        "up" | "down" => {
            let direction = if key == "up" { -1 } else { 1 };
            let text = keyboard_step(&mut hub.borrow_mut(), direction);
            if let Some(text) = text {
                say(hub, &text, window, cx);
            }
        }
        "space" | "enter" => finish(hub, true, window, cx),
        "escape" | "tab" => finish(hub, false, window, cx),
        _ => return false,
    }
    key != "tab"
}
