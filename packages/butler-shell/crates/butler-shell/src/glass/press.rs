//! The native press of glass and text buttons: a control eases in over 120 ms while held
//! (it grows and its fill lightens), eases back on release, and activates once, only when
//! released over it (press, drag out and release cancels; a repeated mouse down while held
//! does not restart the press).
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{Bounds, IntoElement, Pixels, Point, SharedString, Styled, canvas};

/// Press timing: the control settles 120 ms after the press (measured on native controls).
const PRESS: f32 = 0.120;
/// How long frames keep coming after a press or release (the ease plus a frame).
const SETTLE: Duration = Duration::from_millis(140);

#[derive(Default)]
pub(crate) struct Presses {
    /// The control held down, when the press (re)started, and whether the pointer is over it.
    held: Option<(SharedString, Instant, bool)>,
    /// The control last released (or dragged out of), when, and how far it was pressed then.
    released: Option<(SharedString, Instant, f32)>,
    /// Each pressable control's bounds from the last frame (the release-inside test).
    bounds: Rc<RefCell<HashMap<SharedString, Bounds<Pixels>>>>,
}

fn ease(t: f32) -> f32 {
    1. - (1. - t.clamp(0., 1.)).powi(3)
}

fn progress(since: Instant, now: Instant) -> f32 {
    now.saturating_duration_since(since).as_secs_f32() / PRESS
}

impl Presses {
    /// How far `key` is pressed (0..1).
    pub(crate) fn amount(&self, key: &str, now: Instant) -> f32 {
        if let Some((held, at, true)) = &self.held
            && held == key
        {
            return ease(progress(*at, now));
        }
        match &self.released {
            Some((k, at, from)) if k == key => from * (1. - ease(progress(*at, now))),
            _ => 0.,
        }
    }

    /// Whether a press or release is still easing (keep requesting frames).
    pub(crate) fn animating(&self, now: Instant) -> bool {
        let recent = |at: &Instant| now.saturating_duration_since(*at) < SETTLE;
        self.held.as_ref().is_some_and(|(_, at, _)| recent(at))
            || self.released.as_ref().is_some_and(|(_, at, _)| recent(at))
    }

    /// Mouse down over `key`; false when a press is already held.
    pub(crate) fn start(&mut self, key: SharedString, now: Instant) -> bool {
        if self.held.is_some() {
            return false;
        }
        self.held = Some((key, now, true));
        true
    }

    /// Mouse up anywhere ends the press; returns the control to activate (released over it).
    pub(crate) fn end(&mut self, position: Point<Pixels>, now: Instant) -> Option<SharedString> {
        let (key, _, inside_before) = self.held.clone()?;
        let from = self.amount(&key, now);
        self.held = None;
        // A press dragged out already started easing back there.
        if inside_before {
            self.released = Some((key.clone(), now, from));
        }
        self.contains(&key, position).then_some(key)
    }

    /// The pointer moved while a control is held; true when it left or re-entered the control.
    pub(crate) fn moved(&mut self, position: Point<Pixels>, now: Instant) -> bool {
        let Some((key, _, inside)) = self.held.clone() else {
            return false;
        };
        let now_inside = self.contains(&key, position);
        if now_inside == inside {
            return false;
        }
        if !now_inside {
            self.released = Some((key.clone(), now, self.amount(&key, now)));
        }
        self.held = Some((key, now, now_inside));
        true
    }

    fn contains(&self, key: &str, position: Point<Pixels>) -> bool {
        self.bounds
            .borrow()
            .get(key)
            .is_some_and(|b| b.contains(&position))
    }

    /// An absolute probe that records `key`'s bounds each frame; put it inside the control.
    pub(crate) fn probe(&self, key: SharedString) -> impl IntoElement + use<> {
        let bounds = self.bounds.clone();
        canvas(
            move |b, _, _| {
                bounds.borrow_mut().insert(key.clone(), b);
            },
            |_, (), _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}
