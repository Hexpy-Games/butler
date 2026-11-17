//! DS Collapsible (Collapsible.tsx / Collapsible.module.css): a height and opacity reveal for
//! disclosure content. Opening reveals from height 0 to the content's measured height (CSS
//! `interpolate-size: allow-keywords`) over `--motion-base` standard, then the height is `auto`
//! again; closing folds to 0 over `--motion-exit-base` accelerate and unmounts unless the
//! content is kept. Content that starts open does not animate unless `appear` is set. The height
//! is layout, as in CSS: while it moves, each frame lays out the eased height, so the parents
//! (a card's glass, a toolbar below) follow it. The clip paints `--focus-ring-room` past the box
//! (`overflow-clip-margin`) without taking layout room.
//! Reduced motion: no frame loop and no timer. The height snaps at once (opening mounts and
//! fades in over `--motion-fast`, closing unmounts or collapses in the same pass), and the exit
//! handler of closed content runs deferred.
mod clip;
mod list;

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Edges, ElementId, InteractiveElement as _, IntoElement, ParentElement,
    RenderOnce, Styled as _, Window, canvas, div, px,
};

use clip::ClipMargin;
pub use list::{CollapsibleList, Row};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing, transition};
use crate::ui::{focus, strut};

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
    natural: Rc<Cell<Option<f32>>>,
    started: bool,
    generation: usize,
}

impl State {
    fn new(open: bool, keep: KeepMounted, appear: bool) -> Self {
        Self {
            open,
            mounted: open || keep != KeepMounted::No,
            phase: if open && appear {
                Phase::Opening
            } else {
                Phase::Settled
            },
            natural: Rc::new(Cell::new(None)),
            started: false,
            generation: 0,
        }
    }

    /// Whether a pending reveal starts (a timer arms), whether closed content has exited at
    /// once (reduced motion), and the timing.
    fn step(&mut self, open: bool, keep: KeepMounted, ds: &Ds) -> (bool, bool, Timing) {
        let reduced = ds.reduced_motion();
        let timing = if open {
            Timing::token(
                ds,
                if reduced {
                    DsDuration::MotionFast
                } else {
                    DsDuration::MotionBase
                },
                Easing::MotionEaseStandard,
            )
        } else {
            Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate)
        };

        if self.open != open {
            self.open = open;
            self.phase = if open { Phase::Opening } else { Phase::Closing };
            self.mounted |= open;
            self.started = false;
            self.generation += 1;
        }
        let exited = reduced && self.phase == Phase::Closing && keep == KeepMounted::No;
        if reduced && self.phase != Phase::Settled {
            self.phase = Phase::Settled;
            self.mounted = open || keep != KeepMounted::No;
            self.generation += 1;
        }
        let start = !self.started
            && self.phase != Phase::Settled
            && (self.phase == Phase::Closing || self.natural.get().is_some());
        self.started |= start;
        (start, exited, timing)
    }

    fn advance(
        state: &gpui::Entity<Self>,
        keep: KeepMounted,
        timing: &Timing,
        on_exit: Option<ExitHandler>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (open, generation) = {
            let s = state.read(cx);
            (s.open, s.generation)
        };
        let state = state.clone();
        let duration = timing.duration;
        crate::ui::motion::delay(window, cx, duration, move |window, cx| {
            let exited = state.update(cx, |s, cx| {
                if s.generation != generation {
                    return false;
                }
                s.phase = Phase::Settled;
                s.mounted = open || keep != KeepMounted::No;
                cx.notify();
                !open && keep == KeepMounted::No
            });
            if let (true, Some(handler)) = (exited, on_exit) {
                handler(window, cx);
            }
        });
    }
}

/// Records the content's own height as it paints; the first one starts a pending reveal.
fn measure(state: &gpui::Entity<State>, natural: Rc<Cell<Option<f32>>>) -> impl IntoElement {
    let probe = state.clone();
    canvas(
        |_, _, _| (),
        move |bounds, (), _, cx| {
            let height = Some(f32::from(bounds.size.height));
            let first = natural.replace(height).is_none();
            if first {
                probe.update(cx, |_, cx| cx.notify());
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

impl RenderOnce for Collapsible {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (open, keep, appear) = (self.open, self.keep, self.appear);
        let state = window.use_keyed_state(self.id.clone(), cx, move |_, _| {
            State::new(open, keep, appear)
        });
        let (start, exited, timing) = state.update(cx, |s, cx| s.step(open, keep, Ds::get(cx)));
        let s = state.read(cx);
        let (mounted, phase, started) = (s.mounted, s.phase, s.started);
        let natural = s.natural.clone();
        let target = f32::from(open && (phase != Phase::Opening || started));
        let opacity = transition(
            (self.id.clone(), "opacity"),
            (target, false),
            &timing,
            window,
            cx,
        );
        if exited && let Some(handler) = self.on_exit.clone() {
            window.defer(cx, move |window, cx| handler(window, cx));
        }
        if start {
            State::advance(&state, keep, &timing, self.on_exit, window, cx);
        }
        if !mounted {
            return div().id((self.id, "height")).hidden().into_any_element();
        }
        if !open && keep == KeepMounted::Hidden && phase == Phase::Settled {
            return div().id((self.id, "height")).h(px(0.)).into_any_element();
        }
        let content = div()
            .relative()
            .flex_none()
            .child(measure(&state, natural.clone()))
            .children(
                self.children
                    .into_iter()
                    .map(|child| strut::scope(true, child)),
            );
        let mut frame = div().id((self.id, "height")).min_h_0().child(content);
        let collapsed = !open || (phase == Phase::Opening && !started);
        if phase != Phase::Settled && opacity.moving(&timing) {
            // CSS transitions height and opacity on one curve: the height is the natural height
            // at the opacity's eased progress, laid out again each frame until it lands.
            let natural = natural.get().unwrap_or(0.);
            frame = frame.h(px(natural * opacity.value(&timing)));
            crate::ui::motion::layout_transition_frame(window);
        } else if collapsed {
            frame = frame.h(px(0.));
        } else if phase == Phase::Opening {
            frame = frame.h(px(natural.get().unwrap_or(0.)));
        }
        let frame = opacity.apply(
            frame,
            &timing,
            &Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        );
        let room = focus::room(Ds::get(cx));
        ClipMargin::new(frame.into_any_element(), Edges::all(room)).into_any_element()
    }
}
