//! The line variant's sliding underline (TabsIndicator.tsx): a bar `--border-width-strong` high
//! under the active trigger, placed from its measured box and sliding over `--motion-base`
//! decelerate when the selection changes. The first placement and any resize of the list or a
//! trigger land without sliding (`data-indicator-ready`); nothing shows while no trigger is
//! active. Boxes are measured while painting, relative to the list's content origin, so the bar
//! scrolls with the triggers.
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    App, Bounds, Div, ElementId, ParentElement as _, Pixels, Styled as _, Window, canvas, div, px,
};

use crate::tokens::{Color, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, transition};

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
    /// The content's width and each trigger's: a change is a resize.
    sizes: Vec<f32>,
    ready: bool,
    pub(super) measure: Shared,
}

impl Slide {
    pub(super) fn new() -> Self {
        Self {
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
        id: &ElementId,
        active: Option<usize>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Div> {
        let ds = Ds::get(cx);
        let reduced = ds.reduced_motion();
        let timing = Timing::token(
            ds,
            crate::tokens::Duration::MotionBase,
            Easing::MotionEaseDecelerate,
        );
        let (bottom, height, color) = (
            ds.len(Length::FocusRingRoom),
            ds.len(Length::BorderWidthStrong),
            ds.color(Color::Accent),
        );
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
            return None;
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
        let x = transition((id.clone(), "indicator-x"), (x, jump), &timing, window, cx);
        let width = transition(
            (id.clone(), "indicator-width"),
            (width, jump),
            &timing,
            window,
            cx,
        );
        let left = x.from.min(x.to);
        let right = (x.from + width.from).max(x.to + width.to);
        let clip = |x: f32, width: f32| gpui::Edges {
            left: px(x - left),
            right: px(right - x - width),
            ..Default::default()
        };
        let mut motion = x.motion(&timing);
        motion.clip = Some((clip(x.from, width.from), clip(x.to, width.to)));
        Some(
            div()
                .absolute()
                .left(px(left))
                .w(px(right - left))
                .bottom(bottom)
                .h(height)
                .motion(motion)
                .child(div().size_full().bg(color)),
        )
    }
}
