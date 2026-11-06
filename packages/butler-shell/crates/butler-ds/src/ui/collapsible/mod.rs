//! DS Collapsible (Collapsible.tsx / Collapsible.module.css): a height and opacity reveal for
//! disclosure content. Opening reveals from height 0 to the content's measured height (CSS
//! `interpolate-size: allow-keywords`) over `--motion-base` standard, then the height is `auto`
//! again; closing folds to 0 over `--motion-exit-base` accelerate and unmounts unless the
//! content is kept. Content that starts open does not animate unless `appear` is set. The clip
//! keeps `--focus-ring-room` of paint room around the content (`overflow-clip-margin`): the
//! box bleeds that room out with a negative margin and pads it back, so layout does not move.
//! Reduced motion: the height never animates; opening snaps it and fades in over
//! `--motion-fast`, closing fades out first and only then snaps shut.
mod list;

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, Styled as _, Window,
    canvas, div, px,
};

pub use list::{CollapsibleList, Row};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::Ramp;
use crate::ui::{convert, focus, strut};

/// What happens to closed content.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KeepMounted {
    /// Unmount it once the exit has run.
    #[default]
    No,
    /// Keep it, hidden (inert, visibility hidden once closed).
    Hidden,
    /// Keep it collapsed but focusable (its owner reopens it on focus).
    Focusable,
}

type ExitHandler = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Collapsible {
    id: ElementId,
    open: bool,
    keep: KeepMounted,
    appear: bool,
    on_exit: Option<ExitHandler>,
    children: Vec<AnyElement>,
}

impl Collapsible {
    pub fn new(id: impl Into<ElementId>, open: bool) -> Self {
        Self {
            id: id.into(),
            open,
            keep: KeepMounted::No,
            appear: false,
            on_exit: None,
            children: Vec::new(),
        }
    }

    pub fn keep_mounted(mut self, keep: KeepMounted) -> Self {
        self.keep = keep;
        self
    }

    /// Reveal on the first mount too (a list row inserted after the list rendered).
    pub fn appear(mut self) -> Self {
        self.appear = true;
        self
    }

    /// Called once closed content has finished its exit (and unmounted).
    pub fn on_exit_complete(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_exit = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Collapsible {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Settled,
    Opening,
    Closing,
}

struct State {
    open: bool,
    mounted: bool,
    phase: Phase,
    /// `None`: height `auto`.
    height: Option<Ramp>,
    opacity: Ramp,
    /// The content's own height, measured while it paints.
    natural: Rc<Cell<Option<f32>>>,
    /// The opening has begun its timers (it waits for the first measurement).
    started: bool,
}

/// What a frame draws.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent facts of one frame"
)]
struct View {
    mounted: bool,
    height: Option<f32>,
    opacity: f32,
    moving: bool,
    exited: bool,
    hidden: bool,
}

/// The clock and curves of one frame.
struct Clock {
    now: std::time::Instant,
    reduced: bool,
    base: std::time::Duration,
    fast: std::time::Duration,
    exit: std::time::Duration,
    standard: Box<dyn Fn(f32) -> f32>,
    accelerate: Box<dyn Fn(f32) -> f32>,
}

impl State {
    fn new(open: bool, keep: KeepMounted, appear: bool) -> Self {
        let revealing = open && appear;
        Self {
            open,
            mounted: open || keep != KeepMounted::No,
            phase: if revealing {
                Phase::Opening
            } else {
                Phase::Settled
            },
            height: (revealing || !open).then(|| Ramp::at(0.)),
            opacity: Ramp::at(f32::from(u8::from(open && !appear))),
            natural: Rc::new(Cell::new(None)),
            started: false,
        }
    }

    fn current(&self) -> f32 {
        self.height
            .map_or_else(|| self.natural.get().unwrap_or(0.), |h| h.value())
    }

    fn step(&mut self, (open, keep): (bool, KeepMounted), clock: &Clock) -> View {
        if open != self.open {
            self.open = open;
            let from = self.current();
            self.height = Some(Ramp::at(from));
            if open {
                self.mounted = true;
                self.phase = Phase::Opening;
                self.started = false;
            } else {
                self.phase = Phase::Closing;
                self.opacity.retarget(0., clock.now, false);
                // Reduced motion keeps the height until the fade has ended.
                if let (false, Some(h)) = (clock.reduced, &mut self.height) {
                    h.retarget(0., clock.now, false);
                }
            }
        }
        if self.phase == Phase::Opening && !self.started {
            self.begin_opening(clock);
        }
        let exited = self.advance(keep, clock);
        let moving = self.phase != Phase::Settled && self.mounted;
        View {
            mounted: self.mounted,
            height: self.height.map(|h| h.value()),
            opacity: self.opacity.value(),
            moving: moving || exited,
            exited,
            hidden: !self.open && keep == KeepMounted::Hidden && self.phase == Phase::Settled,
        }
    }

    /// Opening waits for the content's first measurement, then eases 0 to that height.
    fn begin_opening(&mut self, clock: &Clock) {
        let Some(natural) = self.natural.get() else {
            return;
        };
        self.started = true;
        self.opacity.retarget(1., clock.now, false);
        if let Some(h) = &mut self.height {
            h.retarget(natural, clock.now, clock.reduced);
        }
    }

    /// Samples the ramps and moves to the next phase when they land. True once an exit ended
    /// and the content unmounted.
    fn advance(&mut self, keep: KeepMounted, clock: &Clock) -> bool {
        let (duration, ease): (_, &dyn Fn(f32) -> f32) = match self.phase {
            Phase::Closing => (clock.exit, &*clock.accelerate),
            _ if clock.reduced => (clock.fast, &*clock.standard),
            _ => (clock.base, &*clock.standard),
        };
        let (_, opacity_moving) = self.opacity.sample(clock.now, duration, ease);
        let height_moving = self
            .height
            .as_mut()
            .is_some_and(|h| h.sample(clock.now, duration, ease).1);
        match self.phase {
            Phase::Opening if self.started && !opacity_moving && !height_moving => {
                self.phase = Phase::Settled;
                self.height = None;
                false
            }
            Phase::Closing if !opacity_moving && !height_moving => {
                self.phase = Phase::Settled;
                self.height = Some(Ramp::at(0.));
                let unmount = keep == KeepMounted::No;
                self.mounted = !unmount;
                unmount
            }
            _ => false,
        }
    }
}

impl RenderOnce for Collapsible {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (open, keep, appear) = (self.open, self.keep, self.appear);
        let state = window.use_keyed_state(self.id.clone(), cx, move |_, _| {
            State::new(open, keep, appear)
        });
        let clock = {
            let ds = Ds::get(cx);
            let curve = |ease| Box::new(convert::easing(ds.tokens().ease(ease))) as Box<_>;
            Clock {
                now: cx.background_executor().now(),
                reduced: ds.reduced_motion(),
                base: ds.duration(DsDuration::MotionBase),
                fast: ds.duration(DsDuration::MotionFast),
                exit: ds.duration(DsDuration::MotionExitBase),
                standard: curve(Easing::MotionEaseStandard),
                accelerate: curve(Easing::MotionEaseAccelerate),
            }
        };
        let (view, natural) =
            state.update(cx, |s, _| (s.step((open, keep), &clock), s.natural.clone()));
        if view.moving {
            window.request_animation_frame();
        }
        if let (true, Some(handler)) = (view.exited, self.on_exit.clone()) {
            window.defer(cx, move |window, cx| handler(window, cx));
        }
        if !view.mounted {
            return div().hidden();
        }
        let room = focus::room(Ds::get(cx));
        let measure = canvas(
            |_, _, _| (),
            move |bounds, (), _, _| natural.set(Some(f32::from(bounds.size.height))),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let content = div().relative().flex_none().child(measure).children(
            self.children
                .into_iter()
                .map(|child| strut::scope(true, child)),
        );
        let mut frame = div()
            .m(-room)
            .p(room)
            .min_h_0()
            .overflow_hidden()
            .opacity(view.opacity)
            .child(content);
        if let Some(height) = view.height {
            frame = frame.h(px(height) + room * 2.);
        }
        if view.hidden {
            frame = frame.invisible();
        }
        frame
    }
}
