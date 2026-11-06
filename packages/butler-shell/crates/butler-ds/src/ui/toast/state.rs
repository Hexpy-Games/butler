//! The toast store's state and its rules: each toast's timer (4s, paused while the stack is
//! expanded or a pointer is down), removal and the 200ms before it unmounts, the heights the
//! stack lays out from, and the swipe (sonner's `Toast` and `Toaster` components).
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{Pixels, Point};

use super::layout::Anim;
use super::{Kind, Toast};

/// `TOAST_LIFETIME`.
pub(super) const LIFETIME: Duration = Duration::from_millis(4000);
/// `TIME_BEFORE_UNMOUNT`: a removed toast stays mounted this long.
pub(super) const UNMOUNT: Duration = Duration::from_millis(200);
/// `SWIPE_THRESHOLD`.
const SWIPE_THRESHOLD: f32 = 45.;
/// A swipe faster than this (px per ms) dismisses too.
const SWIPE_VELOCITY: f32 = 0.11;

pub(super) struct Item {
    pub id: u64,
    pub toast: Toast,
    /// What is left of the lifetime; `None` for a toast that stays until it is dismissed.
    pub remaining: Option<Duration>,
    pub running_since: Option<Instant>,
    pub removed_at: Option<Instant>,
    pub swipe_out: bool,
    pub offset_before_remove: f32,
    /// The toast's own height, measured when it is laid out at its natural size.
    pub height: Rc<Cell<f32>>,
    pub anim: Option<Anim>,
    /// When it was first drawn (the loader's clock).
    pub born: Option<Instant>,
    /// How far the pointer has dragged it (up is negative), and whether one is dragging it.
    pub swipe_y: f32,
    pub swiping: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Axis {
    X,
    Y,
}

struct Swipe {
    id: u64,
    start: Point<Pixels>,
    at: Instant,
    axis: Option<Axis>,
}

#[derive(Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent facts of the stack: expanded, hovered, pointer down, opened by hotkey"
)]
pub(super) struct State {
    next: u64,
    /// Newest first: index 0 is the front toast.
    pub items: Vec<Item>,
    pub expanded: bool,
    pub hovered: bool,
    pub interacting: bool,
    /// Set by alt+T: Escape collapses it again.
    pub hotkey: bool,
    swipe: Option<Swipe>,
    pub wake: Option<Instant>,
}

fn lifetime(toast: &Toast) -> Option<Duration> {
    match (toast.kind, toast.duration) {
        (Kind::Loading, _) => None,
        (_, Some(duration)) => Some(duration),
        (_, None) => Some(LIFETIME),
    }
}

impl State {
    /// Adds a toast at the front, or updates the one with its id in place.
    pub(super) fn show(&mut self, toast: Toast) -> u64 {
        let existing = toast
            .id
            .and_then(|id| self.items.iter_mut().find(|item| item.id == id.0));
        if let Some(item) = existing {
            item.remaining = lifetime(&toast);
            item.running_since = None;
            item.toast = toast;
            return item.id;
        }
        self.next += 1;
        let id = toast.id.map_or(self.next, |id| id.0);
        self.next = self.next.max(id);
        self.items.insert(
            0,
            Item {
                id,
                remaining: lifetime(&toast),
                toast,
                running_since: None,
                removed_at: None,
                swipe_out: false,
                offset_before_remove: 0.,
                height: Rc::default(),
                anim: None,
                born: None,
                swipe_y: 0.,
                swiping: false,
            },
        );
        self.settle_expanded();
        id
    }

    /// Fewer than two toasts cannot be expanded (sonner resets it when the list changes).
    fn settle_expanded(&mut self) {
        if self.items.len() <= 1 {
            self.expanded = false;
        }
    }

    /// Where each toast sits when the stack is expanded: the heights and gaps before it, among
    /// the toasts that are not leaving; a leaving one keeps the offset it had.
    pub(super) fn offsets(&self) -> Vec<f32> {
        let mut at = 0.;
        self.items
            .iter()
            .map(|item| {
                if item.removed_at.is_some() {
                    return item.offset_before_remove;
                }
                let offset = at;
                at += item.height.get() + super::layout::GAP;
                offset
            })
            .collect()
    }

    pub(super) fn dismiss(&mut self, id: u64, now: Instant, swipe_out: bool) {
        let offsets = self.offsets();
        let Some(index) = self.items.iter().position(|item| item.id == id) else {
            return;
        };
        let item = &mut self.items[index];
        if item.removed_at.is_none() {
            item.offset_before_remove = offsets[index];
            item.removed_at = Some(now);
            item.swipe_out = swipe_out;
        }
    }

    /// Runs the timers and unmounts what has left: pauses them while expanded or while a pointer
    /// is down, and starts a toast's again when neither holds.
    pub(super) fn tick(&mut self, now: Instant) {
        let paused = self.expanded || self.interacting;
        let mut expired = Vec::new();
        for item in &mut self.items {
            let (None, Some(left)) = (item.removed_at, item.remaining) else {
                continue;
            };
            if paused {
                if let Some(since) = item.running_since.take() {
                    item.remaining =
                        Some(left.saturating_sub(now.saturating_duration_since(since)));
                }
            } else {
                let since = *item.running_since.get_or_insert(now);
                if now.saturating_duration_since(since) >= left {
                    expired.push(item.id);
                }
            }
        }
        for id in expired {
            self.dismiss(id, now, false);
        }
        let before = self.items.len();
        self.items.retain(|item| {
            item.removed_at
                .is_none_or(|at| now.saturating_duration_since(at) < UNMOUNT)
        });
        if self.items.len() != before {
            self.settle_expanded();
        }
    }

    /// The next moment `tick` has something to do.
    pub(super) fn next_wake(&self, now: Instant) -> Option<Instant> {
        self.items
            .iter()
            .filter_map(
                |item| match (item.removed_at, item.running_since, item.remaining) {
                    (Some(at), _, _) => Some(at + UNMOUNT),
                    (None, Some(since), Some(left)) => Some(since + left),
                    _ => None,
                },
            )
            .min()
            .map(|at| at.max(now))
    }

    /// A pointer went down on toast `id` (not on one of its buttons, not a loading toast).
    pub(super) fn begin_swipe(&mut self, id: u64, at: Point<Pixels>, now: Instant) {
        self.interacting = true;
        let live = self.items.iter().any(|item| {
            item.id == id && item.toast.kind != Kind::Loading && item.removed_at.is_none()
        });
        if live {
            self.swipe = Some(Swipe {
                id,
                start: at,
                at: now,
                axis: None,
            });
        }
    }

    /// The pointer moved with a button down: locks the axis after 1px, follows the pointer upward
    /// and, downward, with the dampening of `getDampening`. Only vertical swipes move a
    /// top-centre toast.
    pub(super) fn move_swipe(&mut self, to: Point<Pixels>) -> bool {
        let Some(swipe) = self.swipe.as_mut() else {
            return false;
        };
        let dy = f32::from(to.y - swipe.start.y);
        let dx = f32::from(to.x - swipe.start.x);
        if swipe.axis.is_none() && (dx.abs() > 1. || dy.abs() > 1.) {
            swipe.axis = Some(if dx.abs() > dy.abs() {
                Axis::X
            } else {
                Axis::Y
            });
        }
        let amount = match swipe.axis {
            Some(Axis::Y) if dy < 0. => dy,
            Some(Axis::Y) => {
                let damped = dy / (1.5 + dy.abs() / 20.);
                if damped.abs() < dy.abs() { damped } else { dy }
            }
            _ => 0.,
        };
        let id = swipe.id;
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.swipe_y = amount;
            item.swiping = true;
        }
        true
    }

    /// The button came up: a swipe past 45px, or a fast one, dismisses the toast; otherwise it
    /// goes back.
    pub(super) fn end_swipe(&mut self, now: Instant) {
        self.interacting = false;
        if !self.hovered {
            self.expanded = self.hotkey;
        }
        let Some(swipe) = self.swipe.take() else {
            return;
        };
        let Some(item) = self.items.iter_mut().find(|item| item.id == swipe.id) else {
            return;
        };
        item.swiping = false;
        let amount = if swipe.axis == Some(Axis::Y) {
            item.swipe_y
        } else {
            0.
        };
        let took = now.saturating_duration_since(swipe.at).as_secs_f32() * 1000.;
        let fast = took > 0. && amount.abs() / took > SWIPE_VELOCITY;
        let gone = amount.abs() >= SWIPE_THRESHOLD || fast;
        if !gone {
            item.swipe_y = 0.;
        }
        if gone {
            self.dismiss(swipe.id, now, true);
        }
    }
}
