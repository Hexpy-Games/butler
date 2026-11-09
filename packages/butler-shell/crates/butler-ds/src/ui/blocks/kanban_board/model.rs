//! The geometry of a KanbanDragScope drag (`kanbanDragModel.ts`): which lane is under the
//! pointer, where in it a card would land, where the keyboard moves it next, and the
//! optimistic reorder the product applies. Pure functions over boxes in window pixels.
use gpui::{Bounds, Pixels, SharedString};

/// A drop: `before_item_id` is the card the item lands above, or `None` for the lane's end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KanbanMove {
    pub item_id: SharedString,
    pub from_lane_id: SharedString,
    pub to_lane_id: SharedString,
    pub before_item_id: Option<SharedString>,
}

/// Lanes of item ids in board order, the product's state (`Record<string, string[]>`).
pub type KanbanLanes = Vec<(SharedString, Vec<SharedString>)>;

fn lane_entry<'a>(lanes: &'a mut KanbanLanes, id: &SharedString) -> &'a mut Vec<SharedString> {
    let at = match lanes.iter().position(|(lane, _)| lane == id) {
        Some(at) => at,
        None => {
            lanes.push((id.clone(), Vec::new()));
            lanes.len() - 1
        }
    };
    &mut lanes[at].1
}

/// `applyKanbanMove`: out of the old lane, in above `before_item_id` or at the end of the new one.
pub fn apply_kanban_move(
    lanes: &[(SharedString, Vec<SharedString>)],
    mv: &KanbanMove,
) -> KanbanLanes {
    let mut next = lanes.to_vec();
    lane_entry(&mut next, &mv.from_lane_id).retain(|id| *id != mv.item_id);
    let target = lane_entry(&mut next, &mv.to_lane_id);
    target.retain(|id| *id != mv.item_id);
    let at = mv
        .before_item_id
        .as_ref()
        .and_then(|before| target.iter().position(|id| id == before))
        .unwrap_or(target.len());
    target.insert(at, mv.item_id.clone());
    next
}

/// Where a drop would go: the lane and the card it lands above.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KanbanDropTarget {
    pub lane_id: SharedString,
    pub before_item_id: Option<SharedString>,
}

/// `KanbanLaneLayout`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LaneLayout {
    #[default]
    List,
    /// Cards wrap in columns at least `--kanban-card-min-width` wide (one wide lane, a backlog).
    Grid,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Rect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub(super) fn of(bounds: Bounds<Pixels>) -> Self {
        Self {
            left: bounds.origin.x.as_f32(),
            top: bounds.origin.y.as_f32(),
            width: bounds.size.width.as_f32(),
            height: bounds.size.height.as_f32(),
        }
    }

    fn right(&self) -> f32 {
        self.left + self.width
    }

    fn bottom(&self) -> f32 {
        self.top + self.height
    }

    fn center_x(&self) -> f32 {
        self.left + self.width / 2.
    }

    fn center_y(&self) -> f32 {
        self.top + self.height / 2.
    }
}

pub(super) struct ItemBox {
    pub id: SharedString,
    pub rect: Rect,
}

/// A lane and its cards in reading order, without the dragged card.
pub(super) struct LaneBox {
    pub id: SharedString,
    pub rect: Rect,
    pub layout: LaneLayout,
    pub items: Vec<ItemBox>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Key {
    Up,
    Down,
    Left,
    Right,
}

/// Insertion index (0..=items.len()) for a point inside `lane`.
pub(super) fn insertion_index(lane: &LaneBox, x: f32, y: f32) -> usize {
    lane.items
        .iter()
        .take_while(|item| match lane.layout {
            LaneLayout::Grid => {
                item.rect.bottom() < y || (y >= item.rect.top && x > item.rect.center_x())
            }
            LaneLayout::List => y > item.rect.center_y(),
        })
        .count()
}

/// The lane under the point.
pub(super) fn lane_at_point(lanes: &[LaneBox], x: f32, y: f32) -> Option<&LaneBox> {
    lanes.iter().find(|lane| {
        x >= lane.rect.left
            && x <= lane.rect.right()
            && y >= lane.rect.top
            && y <= lane.rect.bottom()
    })
}

pub(super) fn target_at(lane: &LaneBox, index: usize) -> KanbanDropTarget {
    KanbanDropTarget {
        lane_id: lane.id.clone(),
        before_item_id: lane.items.get(index).map(|item| item.id.clone()),
    }
}

pub(super) fn index_of_target(lane: &LaneBox, target: &KanbanDropTarget) -> usize {
    target
        .before_item_id
        .as_ref()
        .and_then(|before| lane.items.iter().position(|item| item.id == *before))
        .unwrap_or(lane.items.len())
}

/// A drop that leaves the item where it is: its own lane, above the card that already follows it.
pub(super) fn is_noop_drop(
    order: &[SharedString],
    item: &SharedString,
    from_lane: &SharedString,
    target: &KanbanDropTarget,
) -> bool {
    if target.lane_id != *from_lane {
        return false;
    }
    order
        .iter()
        .position(|id| id == item)
        .is_some_and(|at| order.get(at + 1) == target.before_item_id.as_ref())
}

fn overlap(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    (a1.min(b1) - a0.max(b0)).max(0.)
}

/// The nearest accepting lane beside `from` (same row) or above/below it (another board).
fn neighbor_lane<'a>(
    lanes: &'a [LaneBox],
    from: &LaneBox,
    key: Key,
    accepts: &dyn Fn(&str) -> bool,
) -> Option<&'a LaneBox> {
    let sideways = matches!(key, Key::Left | Key::Right);
    let a = from.rect;
    let distance = |lane: &LaneBox| {
        let across = (lane.rect.center_x() - a.center_x()).abs();
        if sideways {
            across
        } else {
            (lane.rect.center_y() - a.center_y()).abs() * 4. + across
        }
    };
    let ahead = |lane: &LaneBox| {
        let r = lane.rect;
        let same_row = overlap(r.top, r.bottom(), a.top, a.bottom()) > 0.;
        match key {
            Key::Right => r.left >= a.right() - 1. && same_row,
            Key::Left => r.right() <= a.left + 1. && same_row,
            Key::Down => r.top >= a.bottom() - 1.,
            Key::Up => r.bottom() <= a.top + 1.,
        }
    };
    lanes
        .iter()
        .filter(|lane| lane.id != from.id && accepts(&lane.id) && ahead(lane))
        .min_by(|x, y| distance(x).total_cmp(&distance(y)))
}

/// Keyboard step. Up/Down move one place in a list lane and leave it past its ends for the lane
/// above or below (another board); in a grid lane Left/Right step through the cards first.
/// Left/Right otherwise pick the neighbor lane in the same row and keep the place, clamped.
pub(super) fn next_keyboard_target(
    lanes: &[LaneBox],
    current: &KanbanDropTarget,
    key: Key,
    accepts: &dyn Fn(&str) -> bool,
) -> Option<KanbanDropTarget> {
    let lane = lanes.iter().find(|lane| lane.id == current.lane_id)?;
    let index = index_of_target(lane, current);
    let (back, forward) = match lane.layout {
        LaneLayout::Grid => (Key::Left, Key::Right),
        LaneLayout::List => (Key::Up, Key::Down),
    };
    if key == back && index > 0 {
        return Some(target_at(lane, index - 1));
    }
    if key == forward && index < lane.items.len() {
        return Some(target_at(lane, index + 1));
    }
    let next = neighbor_lane(lanes, lane, key, accepts)?;
    Some(match key {
        Key::Up => target_at(next, next.items.len()),
        Key::Down => target_at(next, 0),
        Key::Left | Key::Right => target_at(next, index.min(next.items.len())),
    })
}
