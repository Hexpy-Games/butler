//! The pointer and keyboard state of an open menu, shared by its levels (the root and the
//! submenus open from it): which row is highlighted at each level and where focus is, the
//! typeahead of each level, and the submenu hover intent of Radix `MenuSubTrigger`: a submenu
//! opens 100ms after the pointer rests on its trigger, and for 300ms after the pointer leaves
//! the trigger toward it, a polygon from the exit point to the submenu's near and far edges
//! keeps the highlight where it is while the pointer crosses the gap.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui::{App, AppContext as _, Context, Entity, Point, Window};

use super::level::Level;
use crate::ui::overlay::lifecycle::Lifecycle;
use crate::ui::overlay::place::Side;
use crate::ui::overlay::popper::{Anchor, Output};
use crate::ui::overlay::roving::{self, Typeahead};

/// The pointer rests on a submenu trigger this long before it opens (`MenuSubTrigger`).
pub(super) const OPEN_INTENT: Duration = Duration::from_millis(100);
/// The grace polygon lasts this long after the pointer leaves the trigger.
const GRACE: Duration = Duration::from_millis(300);
/// The polygon starts this far behind the exit point so the exit point is inside it.
const BLEED: f32 = 5.;

/// What an open submenu keeps between frames.
#[derive(Clone)]
pub(super) struct SubRt {
    pub life: Entity<Lifecycle>,
    pub trigger: Anchor,
    pub surface: Anchor,
    pub output: Output,
}

#[derive(Default)]
pub(super) struct LevelState {
    pub highlight: Option<usize>,
    typeahead: Typeahead,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Dir {
    Left,
    #[default]
    Right,
}

struct Grace {
    area: Vec<(f32, f32)>,
    side: Dir,
    until: Instant,
}

#[derive(Default)]
pub(super) struct Runtime {
    /// The trigger index of each open submenu, root level first.
    pub path: Vec<usize>,
    /// One per open level (`path.len() + 1`).
    pub levels: Vec<LevelState>,
    /// The level that holds focus: its highlight is the one drawn and the one keys act on.
    pub focus_level: usize,
    last_x: f32,
    dir: Dir,
    /// A hover-open is waiting on its timer; bumped to cancel.
    pending: Option<u64>,
    serial: u64,
    grace: Option<Grace>,
    pub subs: HashMap<Vec<usize>, SubRt>,
    /// The menu closed because of a pointer or focus outside: focus is not restored.
    pub outside: bool,
    /// The next open comes from the keyboard (the first item takes the highlight).
    pub keyboard: bool,
    was_open: bool,
}

/// The row a pointer event is on.
#[derive(Clone, Copy)]
pub(super) struct Row {
    pub lvl: usize,
    pub idx: usize,
    pub disabled: bool,
    pub sub: bool,
}

impl Runtime {
    /// A fresh open: the first item is highlighted for a keyboard open, none for a pointer one.
    pub(super) fn reset(&mut self, first: Option<usize>) {
        self.path.clear();
        self.levels = vec![LevelState {
            highlight: first,
            ..LevelState::default()
        }];
        self.focus_level = 0;
        self.pending = None;
        self.serial += 1;
        self.grace = None;
        self.outside = false;
    }

    /// Follows the open state of the root: on the opening edge everything starts afresh.
    pub(super) fn begin(&mut self, open: bool, first: Option<usize>) {
        if open && !self.was_open {
            let keyboard = self.keyboard;
            self.reset(first.filter(|_| keyboard));
        }
        self.was_open = open;
    }

    /// The highlight drawn at `lvl`: only the level that holds focus shows one.
    pub(super) fn shown(&self, lvl: usize) -> Option<usize> {
        if self.focus_level == lvl {
            self.levels.get(lvl).and_then(|state| state.highlight)
        } else {
            None
        }
    }

    pub(super) fn highlight(&self, lvl: usize) -> Option<usize> {
        self.levels.get(lvl).and_then(|state| state.highlight)
    }

    fn level(&mut self, lvl: usize) -> &mut LevelState {
        if self.levels.len() <= lvl {
            self.levels.resize_with(lvl + 1, LevelState::default);
        }
        &mut self.levels[lvl]
    }

    pub(super) fn set_highlight(&mut self, lvl: usize, idx: Option<usize>) {
        self.level(lvl).highlight = idx;
        self.focus_level = lvl;
    }

    /// Closes the submenus deeper than `lvl`.
    pub(super) fn close_below(&mut self, lvl: usize) {
        self.path.truncate(lvl);
        self.levels.truncate(lvl + 1);
        self.focus_level = self.focus_level.min(lvl);
    }

    /// Opens the submenu of trigger `idx` at `lvl`. A keyboard open passes the first enabled
    /// item of the submenu and moves focus into it; a hover open leaves focus on the trigger.
    pub(super) fn open_sub(
        &mut self,
        lvl: usize,
        idx: usize,
        first: Option<usize>,
        keyboard: bool,
    ) {
        self.close_below(lvl);
        self.path.push(idx);
        self.levels.push(LevelState {
            highlight: first,
            ..LevelState::default()
        });
        if keyboard {
            self.focus_level = lvl + 1;
        }
        self.pending = None;
    }

    /// ArrowLeft in a submenu: it closes and focus returns to its trigger.
    pub(super) fn close_focused_sub(&mut self) -> bool {
        if self.focus_level == 0 || self.path.is_empty() {
            return false;
        }
        let lvl = self.focus_level - 1;
        self.close_below(lvl);
        self.focus_level = lvl;
        true
    }

    /// Up, Down, Home, End, PageUp and PageDown at the focused level: they step or jump over
    /// enabled rows without wrapping; with no row highlighted (the content holds focus) Down,
    /// PageUp and Home go to the first row and Up, PageDown and End to the last.
    pub(super) fn navigate(&mut self, level: &Level, key: &str, modified: bool) -> bool {
        let lvl = self.focus_level;
        let current = self.highlight(lvl);
        let intent = match current {
            Some(_) => roving::intent(key, modified),
            None => roving::content_intent(key),
        };
        let Some(intent) = intent else {
            return false;
        };
        let disabled: Vec<bool> = level.selectable().iter().map(|row| row.disabled).collect();
        if let Some(next) = roving::target(&disabled, current, intent, false) {
            self.set_highlight(lvl, Some(next));
        }
        true
    }

    /// Whether a typeahead search is running at the focused level.
    pub(super) fn searching(&self, now: Instant) -> bool {
        self.levels
            .get(self.focus_level)
            .is_some_and(|state| state.typeahead.running(now))
    }

    /// A printable key joins the focused level's search and highlights the match.
    pub(super) fn search(&mut self, level: &Level, key: &str, now: Instant) {
        let lvl = self.focus_level;
        let rows = level.selectable();
        let enabled: Vec<_> = rows.iter().filter(|row| !row.disabled).collect();
        let labels: Vec<&str> = enabled.iter().map(|row| row.label.as_ref()).collect();
        let current = self
            .highlight(lvl)
            .and_then(|at| enabled.iter().position(|row| row.idx == at));
        let found = self.level(lvl).typeahead.push(key, now, &labels, current);
        if let Some(row) = found.and_then(|at| enabled.get(at)) {
            self.set_highlight(lvl, Some(row.idx));
        }
    }

    pub(super) fn track_pointer(&mut self, x: f32) {
        if (self.last_x - x).abs() > f32::EPSILON {
            self.dir = if x > self.last_x {
                Dir::Right
            } else {
                Dir::Left
            };
            self.last_x = x;
        }
    }

    fn moving_to_submenu(&self, at: Point<gpui::Pixels>, now: Instant) -> bool {
        self.grace.as_ref().is_some_and(|grace| {
            now < grace.until
                && grace.side == self.dir
                && in_polygon((f32::from(at.x), f32::from(at.y)), &grace.area)
        })
    }

    /// A submenu's runtime: made on first use and kept.
    pub(super) fn sub(&mut self, path: &[usize], cx: &mut Context<Self>) -> SubRt {
        if let Some(sub) = self.subs.get(path) {
            return sub.clone();
        }
        let sub = SubRt {
            life: cx.new(|_| Lifecycle::default()),
            trigger: Anchor::default(),
            surface: Anchor::default(),
            output: Output::default(),
        };
        self.subs.insert(path.to_vec(), sub.clone());
        sub
    }

    /// The pointer left a submenu trigger: sets the grace polygon toward its surface.
    fn leave_trigger(&mut self, path: &[usize], at: Point<gpui::Pixels>, now: Instant) {
        self.pending = None;
        let Some(sub) = self.subs.get(path) else {
            return;
        };
        let (Some(rect), Some(resolved)) = (sub.surface.bounds(), sub.output.get()) else {
            return;
        };
        let right = resolved.side != Side::Left;
        let (near, far) = if right {
            (f32::from(rect.left()), f32::from(rect.right()))
        } else {
            (f32::from(rect.right()), f32::from(rect.left()))
        };
        let (top, bottom) = (f32::from(rect.top()), f32::from(rect.bottom()));
        let bleed = if right { -BLEED } else { BLEED };
        self.grace = Some(Grace {
            area: vec![
                (f32::from(at.x) + bleed, f32::from(at.y)),
                (near, top),
                (far, top),
                (far, bottom),
                (near, bottom),
            ],
            side: if right { Dir::Right } else { Dir::Left },
            until: now + GRACE,
        });
    }
}

pub(super) fn first_enabled(level: &Level) -> Option<usize> {
    let disabled: Vec<bool> = level.selectable().iter().map(|s| s.disabled).collect();
    roving::target(&disabled, None, roving::Intent::First, false)
}

/// `isPointInPolygon` (ray casting).
fn in_polygon((x, y): (f32, f32), polygon: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let mut j = polygon.len().saturating_sub(1);
    for (i, &(xi, yi)) in polygon.iter().enumerate() {
        let (xj, yj) = polygon[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// The pointer moved over a row: it takes the highlight, unless the pointer is crossing to a
/// submenu, and a submenu trigger starts its open intent.
pub(super) fn pointer_move(
    rt: &Entity<Runtime>,
    row: Row,
    at: Point<gpui::Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let now = cx.background_executor().now();
    let start = rt.update(cx, |rt, cx| {
        // gpui tells the row under the pointer before the row it left, so the move that leaves
        // an open submenu's trigger sets the grace polygon itself.
        match rt.path.get(row.lvl).copied() {
            Some(open) if open == row.idx => rt.grace = None,
            Some(_) if rt.grace.is_none() => {
                let trigger = rt.path[..=row.lvl].to_vec();
                rt.leave_trigger(&trigger, at, now);
            }
            _ => {}
        }
        if rt.moving_to_submenu(at, now) {
            return None;
        }
        let same = rt.highlight(row.lvl) == Some(row.idx) && rt.focus_level == row.lvl;
        if row.disabled {
            rt.set_highlight(row.lvl, None);
            cx.notify();
            return None;
        }
        let open_here = rt.path.get(row.lvl) == Some(&row.idx);
        if !open_here {
            rt.close_below(row.lvl);
        }
        rt.set_highlight(row.lvl, Some(row.idx));
        if !same || !open_here {
            cx.notify();
        }
        if row.sub && !open_here && rt.pending.is_none() {
            rt.grace = None;
            rt.serial += 1;
            rt.pending = Some(rt.serial);
            return Some(rt.serial);
        }
        None
    });
    if let Some(serial) = start {
        schedule_open(rt, row, serial, window, cx);
    }
}

fn schedule_open(rt: &Entity<Runtime>, row: Row, serial: u64, window: &mut Window, cx: &mut App) {
    let rt = rt.clone();
    crate::ui::motion::delay(window, cx, OPEN_INTENT, move |_, cx| {
        rt.update(cx, |rt, cx| {
            if rt.pending == Some(serial) {
                rt.open_sub(row.lvl, row.idx, None, false);
                cx.notify();
            }
        });
    });
}

/// The pointer left a row: a submenu trigger cancels its open intent and sets the grace
/// polygon toward its submenu; then the row drops the highlight unless the pointer is crossing
/// to the submenu.
pub(super) fn pointer_leave(
    rt: &Entity<Runtime>,
    row: Row,
    path: &[usize],
    window: &Window,
    cx: &mut App,
) {
    let now = cx.background_executor().now();
    let at = window.mouse_position();
    rt.update(cx, |rt, cx| {
        if row.sub {
            rt.leave_trigger(path, at, now);
        }
        if rt.moving_to_submenu(at, now) || rt.highlight(row.lvl) != Some(row.idx) {
            return;
        }
        rt.set_highlight(row.lvl, None);
        cx.notify();
    });
}
