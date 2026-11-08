//! The state of an open Select: the highlighted item (Radix focuses the item under the pointer
//! or the one the keys reach), the typeahead of the list and of the closed trigger, where the
//! press that opened the list went down (for press, drag and release), the measured geometry,
//! and the 50ms auto-scroll of the scroll buttons.
use std::time::{Duration, Instant};

use gpui::{App, Entity, Pixels, Point, ScrollHandle, Window, point, px};

use super::aligned::Geometry;
use crate::ui::overlay::roving::{self, Intent, Typeahead};

/// A scroll button scrolls by one item every 50ms while the pointer is over it.
const AUTO_SCROLL: Duration = Duration::from_millis(50);
/// A release this close to the press that opened the list does not select (`<= 10`).
const MOVE_GUARD: f32 = 10.;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Way {
    Up,
    Down,
}

#[derive(Default)]
pub(super) struct Rt {
    pub highlight: Option<usize>,
    typeahead: Typeahead,
    trigger_search: Typeahead,
    /// Where the press that opened the list went down, until its release.
    down: Option<(f32, f32)>,
    moved: (f32, f32),
    /// The position of a release that must not select (it ended the opening press).
    suppress: Option<Point<Pixels>>,
    pub geometry: Option<Geometry>,
    /// The geometry is measured again once, when the first scroll button appears.
    pub rescued: bool,
    pub buttons: (bool, bool),
    pub scroll: ScrollHandle,
    /// The running auto-scroll: its serial and the button's way.
    auto: Option<(u64, Way)>,
    serial: u64,
    was_open: bool,
}

impl Rt {
    /// Follows the open state: a fresh open forgets the last one's geometry and highlight.
    pub(super) fn begin(&mut self, open: bool, first: Option<usize>) {
        if open && !self.was_open {
            self.highlight = first;
            self.typeahead = Typeahead::default();
            self.geometry = None;
            self.rescued = false;
            self.buttons = (false, false);
            self.scroll.set_offset(point(px(0.), px(0.)));
            self.auto = None;
        }
        if !open {
            self.down = None;
            self.suppress = None;
            self.auto = None;
        }
        self.was_open = open;
    }

    /// Whether the list can scroll up and down (the scroll buttons show).
    pub(super) fn scroll_buttons(&self) -> (bool, bool) {
        let top = -f32::from(self.scroll.offset().y);
        let max = f32::from(self.scroll.max_offset().y);
        (top > 0., top.ceil() < max)
    }

    /// The opening press went down here (window px).
    pub(super) fn press(&mut self, at: Point<Pixels>) {
        self.down = Some((f32::from(at.x).round(), f32::from(at.y).round()));
        self.moved = (0., 0.);
    }

    pub(super) fn track_pointer(&mut self, at: Point<Pixels>) {
        if let Some((x, y)) = self.down {
            self.moved = (
                (f32::from(at.x).round() - x).abs(),
                (f32::from(at.y).round() - y).abs(),
            );
        }
    }

    /// A button release before the list's own handlers (capture phase): the one that ends the
    /// opening press, if the pointer hardly moved, selects nothing; if it moved and ended
    /// outside the list, the list closes. True when the list should close.
    pub(super) fn release(&mut self, at: Point<Pixels>, inside: bool) -> bool {
        let Some(_) = self.down.take() else {
            return false;
        };
        if self.moved.0 <= MOVE_GUARD && self.moved.1 <= MOVE_GUARD {
            self.suppress = Some(at);
            false
        } else {
            !inside
        }
    }

    /// An item release: false when it ended the opening press.
    pub(super) fn takes_release(&mut self, at: Point<Pixels>) -> bool {
        self.suppress.take() != Some(at)
    }

    pub(super) fn forget_suppressed(&mut self) {
        self.suppress = None;
    }

    pub(super) fn stop_auto(&mut self) {
        self.auto = None;
    }

    /// Up, Down, Home and End move the highlight over enabled items without wrapping.
    pub(super) fn navigate(&mut self, key: &str, disabled: &[bool]) -> bool {
        let intent = match key {
            "up" => Intent::Prev,
            "down" => Intent::Next,
            "home" => Intent::First,
            "end" => Intent::Last,
            _ => return false,
        };
        if let Some(next) = roving::target(disabled, self.highlight, intent, false) {
            self.highlight = Some(next);
        }
        true
    }

    pub(super) fn searching(&self, now: Instant) -> bool {
        self.typeahead.running(now)
    }

    /// A printable key in the list: the highlight goes to the match.
    pub(super) fn search(&mut self, key: &str, now: Instant, labels: &[(usize, &str)]) {
        let texts: Vec<&str> = labels.iter().map(|(_, label)| *label).collect();
        let current = self
            .highlight
            .and_then(|at| labels.iter().position(|(idx, _)| *idx == at));
        if let Some(found) = self.typeahead.push(key, now, &texts, current) {
            self.highlight = Some(labels[found].0);
        }
    }

    pub(super) fn trigger_searching(&self, now: Instant) -> bool {
        self.trigger_search.running(now)
    }

    /// A printable key on the closed trigger: the item the value moves to.
    pub(super) fn trigger_search(
        &mut self,
        key: &str,
        now: Instant,
        labels: &[(usize, &str)],
        current: Option<usize>,
    ) -> Option<usize> {
        let texts: Vec<&str> = labels.iter().map(|(_, label)| *label).collect();
        let current = current.and_then(|at| labels.iter().position(|(idx, _)| *idx == at));
        self.trigger_search
            .push(key, now, &texts, current)
            .map(|found| labels[found].0)
    }
}

/// Starts the auto-scroll of a scroll button unless it runs: every 50ms the list moves by
/// `step` px until the pointer leaves.
pub(super) fn start_auto(rt: &Entity<Rt>, way: Way, step: f32, window: &mut Window, cx: &mut App) {
    let serial = rt.update(cx, |rt, _| {
        if rt.auto.is_some_and(|(_, running)| running == way) {
            return None;
        }
        rt.serial += 1;
        rt.auto = Some((rt.serial, way));
        Some(rt.serial)
    });
    let Some(serial) = serial else {
        return;
    };
    let rt = rt.clone();
    crate::ui::motion::delay(window, cx, AUTO_SCROLL, move |window, cx| {
        let live = rt.update(cx, |rt, cx| {
            let (up, down) = rt.scroll_buttons();
            let scrollable = if way == Way::Up { up } else { down };
            if rt.auto.map(|(running, _)| running) != Some(serial) || !scrollable {
                if rt.auto.map(|(running, _)| running) == Some(serial) {
                    rt.auto = None;
                }
                return false;
            }
            let offset = rt.scroll.offset();
            let max = rt.scroll.max_offset().y;
            let by = px(match way {
                Way::Up => step,
                Way::Down => -step,
            });
            let y = (offset.y + by).clamp(-max, px(0.));
            rt.scroll.set_offset(point(offset.x, y));
            rt.auto = None;
            cx.notify();
            true
        });
        if live {
            start_auto(&rt, way, step, window, cx);
        }
    });
}
