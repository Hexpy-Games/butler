//! The scroll-edge fade engine (card section 36, DS `useScrollEdges` + `scroll-fade.css`).
//! A scroller keeps three edge flags (overflowing, at start, at end, 1px tolerance). An edge
//! fades over `--scroll-fade-size` only while the content is clipped there; the length eases over
//! `--motion-base` decelerate (at once under reduced motion) and a fully transparent guard strip
//! can sit at an active edge. While a ring shows inside, each fade turns solid
//! `--focus-ring-room` sooner. Keyboard focus scrolls the control's ring clear of the fades, and
//! a control whose ring can never fit hands it to the scroller, which draws it inset and drops
//! its fades. gpui has no `mask-image`: the fade is a content mask with edge fades
//! (`ContentMask::fade_out`) pushed over the scroller's own, inset by the guard.
use std::time::Instant;

use gpui::{
    AnyElement, App, Bounds, ContentMask, Div, Edges, Element, ElementId, Entity, FocusHandle,
    GlobalElementId, InspectorElementId, InteractiveElement as _, IntoElement, LayoutId,
    ParentElement as _, Pixels, ScrollHandle, StatefulInteractiveElement as _, Styled as _, Window,
    canvas, point, px,
};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::{Ds, Modality};
use crate::ui::{convert, focus, motion::Ramp};

/// The scroll axis; the fade follows it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Axis {
    X,
    #[default]
    Y,
}

/// Where the content sits against the scroller's edges (1px tolerance, as the DS).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    pub overflowing: bool,
    pub at_start: bool,
    pub at_end: bool,
}

const TOLERANCE: f32 = 1.;
/// The scrollbar stays this long after the content last moved.
pub(super) const LINGER_MS: u128 = 700;

fn component(p: gpui::Point<Pixels>, axis: Axis) -> f32 {
    f32::from(match axis {
        Axis::X => p.x,
        Axis::Y => p.y,
    })
}

/// The scroll position and the farthest it goes.
fn position(handle: &ScrollHandle, axis: Axis) -> (f32, f32) {
    let max = component(handle.max_offset(), axis).max(0.);
    (
        (-component(handle.offset(), axis)).clamp(0., max.max(0.)),
        max,
    )
}

pub fn read(handle: &ScrollHandle, axis: Axis) -> Flags {
    let (position, max) = position(handle, axis);
    let overflowing = max > TOLERANCE;
    Flags {
        overflowing,
        at_start: !overflowing || position <= TOLERANCE,
        at_end: !overflowing || position >= max - TOLERANCE,
    }
}

/// How a scroller fades.
pub struct Config {
    pub id: ElementId,
    pub axis: Axis,
    /// `--scroll-fade-size`.
    pub size: Pixels,
    /// `--scroll-fade-guard`: the transparent strip at an active edge.
    pub guard: Pixels,
}

/// A scroller built by [`scroller`].
pub struct Scroller {
    pub element: AnyElement,
    pub handle: ScrollHandle,
    /// The scroller draws the focused control's ring itself.
    pub host: bool,
    /// The content moved a moment ago (the scrollbar shows).
    pub lingering: bool,
}

struct State {
    handle: ScrollHandle,
    focus: FocusHandle,
    start: Ramp,
    end: Ramp,
    flags: Flags,
    host: bool,
    revealed: Option<FocusHandle>,
    last_position: f32,
    scrolled_at: Option<Instant>,
}

/// The target ring's span against the band the scroller shows clear of its fades.
struct Band {
    low: f32,
    high: f32,
    first: f32,
    last: f32,
}

impl Band {
    fn new(view: Bounds<Pixels>, axis: Axis, fade: f32, room: f32, target: &focus::Target) -> Self {
        let ring = room.max(f32::from(target.ring));
        let (start, size, low, high) = match axis {
            Axis::X => (
                view.left(),
                view.size.width,
                target.bounds.left(),
                target.bounds.right(),
            ),
            Axis::Y => (
                view.top(),
                view.size.height,
                target.bounds.top(),
                target.bounds.bottom(),
            ),
        };
        let start = f32::from(start);
        Self {
            low: f32::from(low) - ring,
            high: f32::from(high) + ring,
            first: start + fade,
            last: start + f32::from(size) - fade,
        }
    }

    /// The ring cannot fit whole at any scroll position.
    fn outgrows(&self) -> bool {
        self.high - self.low > self.last - self.first + 0.5
    }

    /// The scroll needed to bring the ring inside the clear band.
    fn delta(&self) -> f32 {
        if self.low < self.first || self.high - self.low > self.last - self.first {
            self.low - self.first
        } else if self.high > self.last {
            self.high - self.last
        } else {
            0.
        }
    }
}

fn scroll_by(handle: &ScrollHandle, axis: Axis, delta: f32) {
    let (here, max) = position(handle, axis);
    let to = px(-(here + delta).clamp(0., max));
    let offset = handle.offset();
    handle.set_offset(match axis {
        Axis::X => point(to, offset.y),
        Axis::Y => point(offset.x, to),
    });
}

/// Edge fade lengths and guard insets to paint with.
#[derive(Default)]
struct Lengths {
    fade: Edges<Pixels>,
    inset: Edges<Pixels>,
}

/// What a frame needs from the animation clock.
struct Clock<'a> {
    now: Instant,
    duration: std::time::Duration,
    ease: &'a dyn Fn(f32) -> f32,
    instant: bool,
}

impl State {
    /// The fades for this frame (and whether they are still moving).
    fn lengths(&mut self, cfg: &Config, clock: &Clock, room: f32) -> (Lengths, bool) {
        let flags = read(&self.handle, cfg.axis);
        self.flags = flags;
        let size = f32::from(cfg.size);
        let active = |edge_at: bool| flags.overflowing && !edge_at && !self.host;
        let (start_on, end_on) = (active(flags.at_start), active(flags.at_end));
        self.start
            .retarget(if start_on { size } else { 0. }, clock.now, clock.instant);
        self.end
            .retarget(if end_on { size } else { 0. }, clock.now, clock.instant);
        let (start, start_moving) = self.start.sample(clock.now, clock.duration, clock.ease);
        let (end, end_moving) = self.end.sample(clock.now, clock.duration, clock.ease);
        let guard = f32::from(cfg.guard);
        // The fade turns solid `room` early; the guard strip is clipped away first.
        let edge = |length: f32, on: bool| {
            let inset = if on { guard } else { 0. };
            let fade = ((length - room).max(0.) - inset).max(0.);
            (px(fade), px(inset))
        };
        let ((fade_start, inset_start), (fade_end, inset_end)) =
            (edge(start, start_on), edge(end, end_on));
        let mut lengths = Lengths::default();
        match cfg.axis {
            Axis::Y => {
                (lengths.fade.top, lengths.inset.top) = (fade_start, inset_start);
                (lengths.fade.bottom, lengths.inset.bottom) = (fade_end, inset_end);
            }
            Axis::X => {
                (lengths.fade.left, lengths.inset.left) = (fade_start, inset_start);
                (lengths.fade.right, lengths.inset.right) = (fade_end, inset_end);
            }
        }
        (lengths, start_moving || end_moving)
    }

    /// Runs after the scroller painted: reads the new edges, reveals the focused control and
    /// decides the ring host. Returns whether another frame is needed.
    fn observe(
        &mut self,
        (axis, fade, room): (Axis, f32, f32),
        target: Option<focus::Target>,
        now: Instant,
    ) -> bool {
        let mut again = read(&self.handle, axis) != self.flags;
        let (here, _) = position(&self.handle, axis);
        if (here - self.last_position).abs() > 0.01 {
            self.last_position = here;
            self.scrolled_at = Some(now);
            again = true;
        }
        let Some(target) = target else {
            again |= self.host;
            self.host = false;
            self.revealed = None;
            return again;
        };
        let band = Band::new(self.handle.bounds(), axis, fade, room, &target);
        again |= band.outgrows() != self.host;
        self.host = band.outgrows();
        if self.revealed.as_ref() != Some(&target.handle) {
            self.revealed = Some(target.handle.clone());
            if band.delta().abs() >= 0.5 {
                scroll_by(&self.handle, axis, band.delta());
                again = true;
            }
        }
        again
    }
}

/// Makes `content` (a block with its own size and padding) a fading scroller.
pub fn scroller(cfg: &Config, content: Div, window: &mut Window, cx: &mut App) -> Scroller {
    let state = window.use_keyed_state((cfg.id.clone(), "fade"), cx, |_, cx| State {
        handle: ScrollHandle::new(),
        focus: cx.focus_handle().tab_stop(false),
        start: Ramp::at(0.),
        end: Ramp::at(0.),
        flags: Flags::default(),
        host: false,
        revealed: None,
        last_position: 0.,
        scrolled_at: None,
    });
    let now = cx.background_executor().now();
    let (duration, ease, instant, room, keyboard) = {
        let ds = Ds::get(cx);
        (
            ds.duration(DsDuration::MotionBase),
            convert::easing(ds.tokens().ease(Easing::MotionEaseDecelerate)),
            ds.reduced_motion(),
            f32::from(focus::room(ds)),
            ds.modality() == Modality::Keyboard,
        )
    };
    let (handle, focus_handle) = {
        let state = state.read(cx);
        (state.handle.clone(), state.focus.clone())
    };
    let ring_inside = keyboard && focus_handle.contains_focused(window, cx);
    let clock = Clock {
        now,
        duration,
        ease: &ease,
        instant,
    };
    let (lengths, moving, host, lingering) = state.update(cx, |s, _| {
        let (lengths, moving) = s.lengths(cfg, &clock, if ring_inside { room } else { 0. });
        let lingering = s
            .scrolled_at
            .is_some_and(|at| now.saturating_duration_since(at).as_millis() < LINGER_MS);
        (lengths, moving, s.host, lingering)
    });
    if host {
        focus::hand_off_ring(cx);
    }
    if moving || lingering {
        window.request_animation_frame();
    }
    let (axis, fade) = (cfg.axis, f32::from(cfg.size));
    let watch = {
        let state = state.clone();
        canvas(
            |_, _, _| (),
            move |_, (), window, cx| observe(&state, (axis, fade, room), window, cx),
        )
        .absolute()
        .top_0()
        .left_0()
        .size(px(1.))
    };
    let scroller = content
        .id((cfg.id.clone(), "scroll"))
        .track_scroll(&handle)
        .track_focus(&focus_handle);
    let scroller = match cfg.axis {
        Axis::X => scroller.overflow_x_scroll(),
        Axis::Y => scroller.overflow_y_scroll(),
    }
    .child(watch);
    let mask = if host { Lengths::default() } else { lengths };
    Scroller {
        element: Masked::new(scroller.into_any_element(), mask).into_any_element(),
        handle,
        host,
        lingering,
    }
}

fn observe(state: &Entity<State>, params: (Axis, f32, f32), window: &mut Window, cx: &mut App) {
    let now = cx.background_executor().now();
    let keyboard = Ds::get(cx).modality() == Modality::Keyboard;
    let own = state.read(cx).focus.clone();
    let target = window
        .focused(cx)
        .filter(|focused| keyboard && *focused != own && own.contains_focused(window, cx))
        .and_then(|focused| focus::published(cx, &focused));
    if state.update(cx, |s, _| s.observe(params, target, now)) {
        window.request_animation_frame();
    }
}

/// Paints `child` under an extra content mask: inset by the guard, fading at its edges.
struct Masked {
    child: AnyElement,
    lengths: Lengths,
}

impl Masked {
    fn new(child: AnyElement, lengths: Lengths) -> Self {
        Self { child, lengths }
    }

    fn mask(&self, bounds: Bounds<Pixels>) -> ContentMask<Pixels> {
        let inset = &self.lengths.inset;
        let origin = bounds.origin + point(inset.left, inset.top);
        let size = gpui::size(
            (bounds.size.width - inset.left - inset.right).max(px(0.)),
            (bounds.size.height - inset.top - inset.bottom).max(px(0.)),
        );
        ContentMask {
            bounds: Bounds::new(origin, size),
            fade_out: self.lengths.fade,
        }
    }
}

impl IntoElement for Masked {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Masked {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = self.mask(bounds);
        window.with_content_mask(Some(mask), |window| self.child.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = self.mask(bounds);
        window.with_content_mask(Some(mask), |window| self.child.paint(window, cx));
    }
}
