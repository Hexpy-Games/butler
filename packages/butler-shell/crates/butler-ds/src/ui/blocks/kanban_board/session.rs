//! The drag session of a KanbanDragScope (`useKanbanDrag.ts`): the lanes and cards as last
//! painted, the view (what is lifted and where a drop would go), and starting, retargeting and
//! finishing a drag by pointer or keyboard. The state lives in one [`Hub`] kept in the scope's
//! window state; handlers borrow it briefly and call the product's callbacks only after the
//! borrow ends.
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{App, ElementId, SharedString, Window};

use super::labels::KanbanDragLabels;
use super::model::{
    ItemBox, KanbanDropTarget, KanbanMove, Key, LaneBox, LaneLayout, Rect, index_of_target,
    insertion_index, is_noop_drop, lane_at_point, next_keyboard_target, target_at,
};

pub(super) type OnMove = Rc<dyn Fn(KanbanMove, &mut Window, &mut App)>;
pub(super) type CanDrop = Rc<dyn Fn(&str, &str) -> bool>;
pub(super) type OnAnnounce = Rc<dyn Fn(&str, &mut Window, &mut App)>;
pub(super) type Hub = Rc<RefCell<Session>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Pointer,
    Keyboard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Side {
    Before,
    After,
}

/// Where the drop line sits. `item_id` `None`: the lane's start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Anchor {
    pub lane_id: SharedString,
    pub item_id: Option<SharedString>,
    pub side: Side,
}

/// What is lifted and where a drop would go.
#[derive(Clone, Debug, Default)]
pub(super) struct View {
    pub active: Option<SharedString>,
    pub mode: Option<Mode>,
    /// `None` when there is no accepting lane under the pointer.
    pub target: Option<KanbanDropTarget>,
    /// `None` when there is no target or the drop would leave the card where it is.
    pub anchor: Option<Anchor>,
}

impl View {
    /// The drop line side at an anchor point: a card's edge (`item` `Some`) or a lane's start.
    pub(super) fn side(&self, lane: &str, item: Option<&str>) -> Option<Side> {
        self.anchor
            .as_ref()
            .filter(|a| a.lane_id == lane && a.item_id.as_deref() == item)
            .map(|a| a.side)
    }
}

struct LaneEntry {
    id: SharedString,
    rect: Rect,
    layout: LaneLayout,
    label: SharedString,
}

struct CardEntry {
    id: SharedString,
    lane_id: SharedString,
    rect: Rect,
    label: SharedString,
}

#[derive(Default)]
pub(super) struct Config {
    pub labels: KanbanDragLabels,
    pub on_move: Option<OnMove>,
    pub can_drop: Option<CanDrop>,
    pub on_announce: Option<OnAnnounce>,
    pub disabled: bool,
}

pub(super) struct Session {
    pub id: ElementId,
    pub cfg: Config,
    pub view: View,
    lanes: Vec<LaneEntry>,
    cards: Vec<CardEntry>,
    focus_request: Option<SharedString>,
}

/// What a finished drag asks of the caller: the product's move and the announcement.
struct Ended {
    moved: Option<KanbanMove>,
    text: Option<String>,
}

impl Session {
    pub(super) fn new(id: ElementId) -> Self {
        Self {
            id,
            cfg: Config::default(),
            view: View::default(),
            lanes: Vec::new(),
            cards: Vec::new(),
            focus_request: None,
        }
    }

    /// The registry is rebuilt by every paint, in reading order.
    pub(super) fn begin_frame(&mut self) {
        self.lanes.clear();
        self.cards.clear();
    }

    pub(super) fn add_lane(
        &mut self,
        id: SharedString,
        rect: Rect,
        layout: LaneLayout,
        label: SharedString,
    ) {
        self.lanes.push(LaneEntry {
            id,
            rect,
            layout,
            label,
        });
    }

    pub(super) fn add_card(
        &mut self,
        id: SharedString,
        lane_id: SharedString,
        rect: Rect,
        label: SharedString,
    ) {
        self.cards.push(CardEntry {
            id,
            lane_id,
            rect,
            label,
        });
    }

    /// The card's rectangle as last painted (the lifted copy takes its width).
    pub(super) fn card_rect(&self, id: &str) -> Option<Rect> {
        self.cards.iter().find(|c| c.id == id).map(|c| c.rect)
    }

    /// A card asks for focus after it remounted in its new lane (a keyboard drop).
    pub(super) fn take_focus(&mut self, id: &str) -> bool {
        let mine = self.focus_request.as_deref() == Some(id);
        if mine {
            self.focus_request = None;
        }
        mine
    }

    fn card(&self, id: &str) -> Option<&CardEntry> {
        self.cards.iter().find(|c| c.id == id)
    }

    fn order(&self, lane: &str, skip: Option<&str>) -> Vec<SharedString> {
        self.cards
            .iter()
            .filter(|c| c.lane_id == lane && Some(&*c.id) != skip)
            .map(|c| c.id.clone())
            .collect()
    }

    fn lane_boxes(&self, skip: Option<&str>) -> Vec<LaneBox> {
        self.lanes
            .iter()
            .map(|lane| LaneBox {
                id: lane.id.clone(),
                rect: lane.rect,
                layout: lane.layout,
                items: self
                    .cards
                    .iter()
                    .filter(|c| c.lane_id == lane.id && Some(&*c.id) != skip)
                    .map(|c| ItemBox {
                        id: c.id.clone(),
                        rect: c.rect,
                    })
                    .collect(),
            })
            .collect()
    }

    fn accepts(&self, lane: &str) -> bool {
        self.view.active.as_deref().is_some_and(|item| {
            self.cfg
                .can_drop
                .as_ref()
                .is_none_or(|can_drop| can_drop(item, lane))
        })
    }

    /// The lane's name and the 1-based place a target means, without the lifted card.
    fn place(&self, target: &KanbanDropTarget) -> (SharedString, usize) {
        let label = self
            .lanes
            .iter()
            .find(|l| l.id == target.lane_id)
            .map_or_else(|| target.lane_id.clone(), |l| l.label.clone());
        let boxes = self.lane_boxes(self.view.active.as_deref());
        let at = boxes
            .iter()
            .find(|l| l.id == target.lane_id)
            .map_or(0, |l| index_of_target(l, target));
        (label, at + 1)
    }

    /// The anchor of the drop line: above the target card, after the lane's last card, or the
    /// lane's start.
    fn anchor_for(&self, target: Option<&KanbanDropTarget>) -> Option<Anchor> {
        let active = self.view.active.as_ref()?;
        let from = &self.card(active)?.lane_id;
        let target = target?;
        if is_noop_drop(&self.order(from, None), active, from, target) {
            return None;
        }
        if let Some(before) = &target.before_item_id {
            return Some(Anchor {
                lane_id: target.lane_id.clone(),
                item_id: Some(before.clone()),
                side: Side::Before,
            });
        }
        let last = self.order(&target.lane_id, Some(active)).pop();
        let side = if last.is_some() {
            Side::After
        } else {
            Side::Before
        };
        Some(Anchor {
            lane_id: target.lane_id.clone(),
            item_id: last,
            side,
        })
    }

    /// Moves the target; false when nothing changed.
    fn retarget(&mut self, target: Option<KanbanDropTarget>) -> bool {
        let next = target.filter(|t| self.accepts(&t.lane_id));
        if self.view.target == next {
            return false;
        }
        self.view.anchor = self.anchor_for(next.as_ref());
        self.view.target = next;
        true
    }

    fn lift(&mut self, item: &SharedString, mode: Mode) -> Option<String> {
        let (lane, label) = self
            .card(item)
            .map(|c| (c.lane_id.clone(), c.label.clone()))?;
        let order = self.order(&lane, None);
        let before = order
            .iter()
            .position(|id| id == item)
            .and_then(|at| order.get(at + 1))
            .cloned();
        let own = KanbanDropTarget {
            lane_id: lane,
            before_item_id: before,
        };
        self.view = View {
            active: Some(item.clone()),
            mode: Some(mode),
            target: Some(own.clone()),
            anchor: None,
        };
        let (lane, position) = self.place(&own);
        Some((self.cfg.labels.lifted)(&label, &lane, position))
    }

    fn key_step(&mut self, key: Key) -> Option<String> {
        let (active, current) = (self.view.active.clone()?, self.view.target.clone()?);
        let label = self.card(&active)?.label.clone();
        let lanes = self.lane_boxes(Some(&active));
        let next = next_keyboard_target(&lanes, &current, key, &|lane| self.accepts(lane))?;
        if !self.retarget(Some(next.clone())) {
            return None;
        }
        let (lane, position) = self.place(&next);
        Some((self.cfg.labels.over)(&label, &lane, position))
    }

    fn end(&mut self, drop: bool) -> Ended {
        let view = self.view.clone();
        let card = view
            .active
            .as_ref()
            .and_then(|id| self.card(id))
            .map(|c| (c.lane_id.clone(), c.label.clone()));
        let (Some(active), Some((lane, label))) = (view.active.clone(), card) else {
            self.view = View::default();
            return Ended {
                moved: None,
                text: None,
            };
        };
        let labels = &self.cfg.labels;
        let target = view
            .target
            .filter(|t| drop && !is_noop_drop(&self.order(&lane, None), &active, &lane, t));
        let ended = match target {
            _ if !drop => Ended {
                moved: None,
                text: Some((labels.cancelled)(&label)),
            },
            None => Ended {
                moved: None,
                text: Some((labels.unchanged)(&label)),
            },
            Some(target) => {
                let (name, position) = self.place(&target);
                let text = (labels.dropped)(&label, &name, position);
                let moved = KanbanMove {
                    item_id: active.clone(),
                    from_lane_id: lane,
                    to_lane_id: target.lane_id,
                    before_item_id: target.before_item_id,
                };
                if view.mode == Some(Mode::Keyboard) {
                    self.focus_request = Some(active);
                }
                Ended {
                    moved: Some(moved),
                    text: Some(text),
                }
            }
        };
        self.view = View::default();
        ended
    }
}

fn announce(hub: &Hub, text: Option<String>, window: &mut Window, cx: &mut App) {
    let on_announce = hub.borrow().cfg.on_announce.clone();
    if let (Some(text), Some(on_announce)) = (text, on_announce) {
        on_announce(&text, window, cx);
    }
}

/// A drag of `item` starts (the pointer moved off the card, or Space on it).
pub(super) fn begin(
    hub: &Hub,
    item: &SharedString,
    mode: Mode,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let text = hub.borrow_mut().lift(item, mode);
    let started = text.is_some();
    announce(hub, text, window, cx);
    started
}

/// The pointer is at (`x`, `y`) in window pixels; true when the target changed.
pub(super) fn pointer_move(hub: &Hub, x: f32, y: f32) -> bool {
    let mut session = hub.borrow_mut();
    if session.view.mode != Some(Mode::Pointer) {
        return false;
    }
    let lanes = session.lane_boxes(session.view.active.clone().as_deref());
    let target =
        lane_at_point(&lanes, x, y).map(|lane| target_at(lane, insertion_index(lane, x, y)));
    session.retarget(target)
}

/// The drag ended: on a drop the product gets the move.
pub(super) fn finish(hub: &Hub, drop: bool, window: &mut Window, cx: &mut App) {
    let ended = hub.borrow_mut().end(drop);
    let on_move = hub.borrow().cfg.on_move.clone();
    if let (Some(moved), Some(on_move)) = (ended.moved, on_move) {
        on_move(moved, window, cx);
    }
    announce(hub, ended.text, window, cx);
}

fn arrow(key: &str) -> Option<Key> {
    match key {
        "up" => Some(Key::Up),
        "down" => Some(Key::Down),
        "left" => Some(Key::Left),
        "right" => Some(Key::Right),
        _ => None,
    }
}

/// A key on a focused card (`onCardKey`); true when it was handled.
pub(super) fn card_key(
    hub: &Hub,
    item: &SharedString,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let (mine, idle, disabled) = {
        let session = hub.borrow();
        let mine =
            session.view.mode == Some(Mode::Keyboard) && session.view.active.as_ref() == Some(item);
        (mine, session.view.active.is_none(), session.cfg.disabled)
    };
    if !mine {
        return key == "space" && !disabled && idle && begin(hub, item, Mode::Keyboard, window, cx);
    }
    if let Some(key) = arrow(key) {
        let text = hub.borrow_mut().key_step(key);
        announce(hub, text, window, cx);
        return true;
    }
    match key {
        "space" | "enter" => finish(hub, true, window, cx),
        "escape" | "tab" => finish(hub, false, window, cx),
        _ => return false,
    }
    key != "tab"
}

/// A keyboard-lifted card lost focus: the drag is cancelled.
pub(super) fn card_blur(hub: &Hub, item: &SharedString, window: &mut Window, cx: &mut App) {
    let lifted = {
        let session = hub.borrow();
        session.view.mode == Some(Mode::Keyboard) && session.view.active.as_ref() == Some(item)
    };
    if lifted {
        finish(hub, false, window, cx);
    }
}

/// A pointer drag that ended outside the scope is a cancel.
pub(super) fn settle(hub: &Hub, window: &mut Window, cx: &mut App) {
    let stale = hub.borrow().view.mode == Some(Mode::Pointer) && !cx.has_active_drag();
    if stale {
        finish(hub, false, window, cx);
    }
}
