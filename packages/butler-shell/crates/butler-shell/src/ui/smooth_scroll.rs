//! Smooth wheel scrolling for a gpui `list` or an `overflow_y_scroll` div. A wheel notch
//! (ScrollDelta::Lines) moves a target, clamped to the content, and the view eases toward it
//! each frame (exponential approach, time constant TAU_MS: about 95% of a notch in 150ms);
//! notches arriving mid-glide add to the remaining distance, so the glide speeds up instead of
//! restarting. Precise touchpad deltas (ScrollDelta::Pixels) pass straight through to the
//! element's own handler and cancel any glide, so the content follows the finger. Frames are
//! requested only while a glide is in flight.
//!
//! Use: put `layer()` as an absolute sibling right before the scroller in the same relative
//! parent; it eases in prepaint (before the scroller lays out, so a step shows the same frame)
//! and intercepts wheel notches in the capture phase over its bounds.
use butler_ds::ui::motion;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    AppContext as _, DispatchPhase, EntityId, HitboxBehavior, IntoElement, ListState, ScrollDelta,
    ScrollWheelEvent, Styled, Window, canvas, point, px,
};

/// Time constant of the glide.
pub(crate) const TAU_MS: f32 = 50.;
/// Pixels per wheel line: the list's own value (gpui `list`); divs use the window line height.
const LIST_LINE: f32 = 20.;

struct State {
    target: ListState,
    /// Distance still to scroll, in px (positive = toward the end of the content).
    pending: f32,
    last: Option<Instant>,
    view: Option<EntityId>,
}

#[derive(Clone)]
pub(crate) struct SmoothScroll(Rc<RefCell<State>>);

/// One frame of the glide: how far to move this frame out of `pending` after `dt_ms`. Within
/// half a pixel of the end it moves the rest, so a glide always lands exactly.
pub(crate) fn ease(pending: f32, dt_ms: f32) -> f32 {
    let step = pending * (1. - (-dt_ms.max(0.) / TAU_MS).exp());
    if (pending - step).abs() < 0.5 {
        pending
    } else {
        step
    }
}

impl SmoothScroll {
    pub(crate) fn list(list: ListState) -> Self {
        Self(Rc::new(RefCell::new(State {
            target: list,
            pending: 0.,
            last: None,
            view: None,
        })))
    }

    /// Stops a glide (content reset, programmatic scroll).
    pub(crate) fn cancel(&self) {
        let mut s = self.0.borrow_mut();
        s.pending = 0.;
        s.last = None;
    }

    /// The absolute layer that eases and catches wheel notches; see the module docs.
    pub(crate) fn layer(&self) -> impl IntoElement + use<> {
        let (a, b) = (self.clone(), self.clone());
        canvas(
            move |bounds, window, _| {
                a.step(window);
                window.insert_hitbox(bounds, HitboxBehavior::Normal)
            },
            move |_, hitbox, window, _| {
                b.0.borrow_mut().view = Some(window.current_view());
                window.on_mouse_event(move |e: &ScrollWheelEvent, phase, window, cx| {
                    if phase != DispatchPhase::Capture || !hitbox.should_handle_scroll(window) {
                        return;
                    }
                    if let ScrollDelta::Pixels(_) = e.delta {
                        b.cancel();
                        return;
                    }
                    let lines = px(LIST_LINE);
                    let dy = e.delta.pixel_delta(lines).y.as_f32();
                    if dy == 0. {
                        return;
                    }
                    cx.stop_propagation();
                    if b.add(-dy)
                        && let Some(view) = b.0.borrow().view
                    {
                        cx.notify(view);
                    }
                });
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// Adds a notch's distance, clamping the target to the content; true when there is a glide.
    fn add(&self, distance: f32) -> bool {
        let (top, max) = self.position();
        let mut s = self.0.borrow_mut();
        let target = (top + s.pending + distance).clamp(0., max);
        s.pending = target - top;
        if s.last.is_none() {
            s.last = Some(Instant::now());
        }
        s.pending != 0.
    }

    fn step(&self, window: &mut Window) {
        if self.0.borrow().pending == 0. {
            self.0.borrow_mut().last = None;
            return;
        }
        let now = Instant::now();
        let (pending, last) = {
            let s = self.0.borrow();
            (s.pending, s.last)
        };
        let dt = last
            .map(|l| now.saturating_duration_since(l).as_secs_f32() * 1000.)
            .unwrap_or(16.)
            .min(64.);
        let step = ease(pending, dt);
        let (top, max) = self.position();
        let wanted = top + step;
        let landed = wanted.clamp(0., max);
        self.set_top(landed);
        let mut s = self.0.borrow_mut();
        s.last = Some(now);
        // At a bound (content shrank, or the target was out of range) the glide ends there.
        s.pending = if (landed - wanted).abs() > 0.01 {
            0.
        } else {
            pending - step
        };
        if s.pending != 0. {
            motion::input_frame(window);
        }
    }

    /// Current scroll top and its maximum, in px.
    fn position(&self) -> (f32, f32) {
        let state = self.0.borrow();
        let list = &state.target;
        (
            -list.scroll_px_offset_for_scrollbar().y.as_f32(),
            list.max_offset_for_scrollbar().y.as_f32(),
        )
    }

    fn set_top(&self, top: f32) {
        self.0
            .borrow()
            .target
            .set_offset_from_scrollbar(point(px(0.), px(-top)));
    }
}
