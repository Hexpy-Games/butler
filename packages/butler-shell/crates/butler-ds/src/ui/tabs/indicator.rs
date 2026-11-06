//! The line variant's sliding underline (TabsIndicator.tsx): a bar `--border-width-strong` high
//! under the active trigger, placed from its measured box and sliding over `--motion-base`
//! decelerate when the selection changes. The first placement and any resize of the list or a
//! trigger land without sliding (`data-indicator-ready`); nothing shows while no trigger is
//! active. Boxes are measured while painting, relative to the list's content origin, so the bar
//! scrolls with the triggers.
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{App, Bounds, Div, ParentElement as _, Pixels, Styled as _, Window, canvas, div, px};

use crate::tokens::{Color, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::{convert, motion::Ramp};

/// Boxes measured during paint: the content origin and each trigger.
#[derive(Default)]
pub(super) struct Measure {
    origin: Option<Bounds<Pixels>>,
    triggers: Vec<Option<Bounds<Pixels>>>,
}

pub(super) type Shared = Rc<RefCell<Measure>>;

impl Measure {
    /// A canvas that records `slot`'s box (or the content's, for `None`).
    pub(super) fn probe(shared: &Shared, slot: Option<usize>) -> Div {
        let shared = shared.clone();
        div().absolute().top_0().left_0().size_full().child(
            canvas(
                |_, _, _| (),
                move |bounds, (), _, _| {
                    let mut measure = shared.borrow_mut();
                    match slot {
                        None => measure.origin = Some(bounds),
                        Some(slot) => {
                            if measure.triggers.len() <= slot {
                                measure.triggers.resize(slot + 1, None);
                            }
                            measure.triggers[slot] = Some(bounds);
                        }
                    }
                },
            )
            .absolute()
            .size_full(),
        )
    }
}

pub(super) struct Slide {
    x: Ramp,
    width: Ramp,
    /// The content's width and each trigger's: a change is a resize.
    sizes: Vec<f32>,
    ready: bool,
    pub(super) measure: Shared,
}

impl Slide {
    pub(super) fn new() -> Self {
        Self {
            x: Ramp::at(0.),
            width: Ramp::at(0.),
            sizes: Vec::new(),
            ready: false,
            measure: Shared::default(),
        }
    }

    /// Whether the bar is placed (the static underline of the active trigger retires).
    pub(super) fn ready(&self) -> bool {
        self.ready
    }

    /// Places the bar under trigger `active`. Returns the bar to draw and whether it is still
    /// moving.
    pub(super) fn place(
        &mut self,
        active: Option<usize>,
        window: &mut Window,
        cx: &App,
    ) -> (Option<Div>, bool) {
        let ds = Ds::get(cx);
        let (reduced, duration) = (
            ds.reduced_motion(),
            ds.duration(crate::tokens::Duration::MotionBase),
        );
        let ease = convert::easing(ds.tokens().ease(Easing::MotionEaseDecelerate));
        let now = cx.background_executor().now();
        let measure = self.measure.borrow();
        let (Some(origin), Some(box_)) = (
            measure.origin,
            active.and_then(|i| measure.triggers.get(i).copied().flatten()),
        ) else {
            let waiting = active.is_some() && !self.ready;
            drop(measure);
            if waiting {
                window.request_animation_frame();
            }
            return (None, false);
        };
        let sizes: Vec<f32> = std::iter::once(f32::from(origin.size.width))
            .chain(
                measure
                    .triggers
                    .iter()
                    .map(|b| b.map_or(0., |b| f32::from(b.size.width))),
            )
            .collect();
        let x = f32::from(box_.left() - origin.left());
        let width = f32::from(box_.size.width);
        let resized = !self.sizes.is_empty() && self.sizes != sizes;
        let jump = !self.ready || resized || reduced;
        self.sizes = sizes;
        self.ready = true;
        self.x.retarget(x, now, jump);
        self.width.retarget(width, now, jump);
        let ((x, x_moving), (width, width_moving)) = (
            self.x.sample(now, duration, &ease),
            self.width.sample(now, duration, &ease),
        );
        let bar = div()
            .absolute()
            .left(px(x))
            .w(px(width))
            .bottom(ds.len(Length::FocusRingRoom))
            .h(ds.len(Length::BorderWidthStrong))
            .bg(ds.color(Color::Accent));
        (Some(bar), x_moving || width_moving)
    }
}
