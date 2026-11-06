//! DS RollingSwap (RollingSwap.tsx / RollingSwap.module.css): one line of content that rolls
//! to the next when its key changes. The old frame leaves upward while the new one comes in
//! from below, over `--adaptive-panel-duration` on `--adaptive-panel-easing`, clipped to the
//! viewport. Reduced motion, or `motion(false)`, swaps at once.
use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, canvas, div, px,
};

use super::context::Ds;
use super::convert;
use crate::tokens::{Duration as DsDuration, Easing};

/// How a frame's content is drawn; kept so the frame that leaves can be drawn once more.
pub type Frame = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

struct State {
    key: SharedString,
    frame: Frame,
    outgoing: Option<(Frame, Instant)>,
    /// The height of the frame last painted: a frame travels its own height.
    height: Rc<Cell<f32>>,
}

#[derive(IntoElement)]
pub struct RollingSwap {
    id: ElementId,
    item_key: SharedString,
    motion: bool,
    frame: Frame,
}

impl RollingSwap {
    /// `item_key` names the content: a new key rolls to `frame`'s content.
    pub fn new(
        id: impl Into<ElementId>,
        item_key: impl Into<SharedString>,
        frame: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            item_key: item_key.into(),
            motion: true,
            frame: Rc::new(frame),
        }
    }

    pub fn motion(mut self, motion: bool) -> Self {
        self.motion = motion;
        self
    }
}

/// A frame in the viewport's one grid cell, `dy` px down from its place.
fn cell(content: AnyElement, dy: f32, opacity: f32, height: Option<Rc<Cell<f32>>>) -> AnyElement {
    let probe = height.map(|height| {
        canvas(
            move |bounds, _, _| height.set(f32::from(bounds.size.height)),
            |_, (), _, _| {},
        )
        .absolute()
        .size_full()
    });
    div()
        .relative()
        .col_start(1)
        .row_start(1)
        .min_w_0()
        .top(px(dy))
        .opacity(opacity)
        .child(content)
        .children(probe)
        .into_any_element()
}

impl RenderOnce for RollingSwap {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = cx.background_executor().now();
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| State {
            key: self.item_key.clone(),
            frame: self.frame.clone(),
            outgoing: None,
            height: Rc::new(Cell::new(0.)),
        });
        let ds = Ds::get(cx);
        let rolls = self.motion && !ds.reduced_motion();
        let duration = ds.duration(DsDuration::AdaptivePanelDuration);
        let ease = ds.tokens().ease(Easing::AdaptivePanelEasing);
        let (prior, height) = state.update(cx, |state, _| {
            let prior = state.frame.clone();
            if state.key != self.item_key {
                state.outgoing = rolls.then(|| (prior.clone(), now));
                state.key = self.item_key.clone();
            }
            state.frame = self.frame.clone();
            if state
                .outgoing
                .as_ref()
                .is_some_and(|(_, since)| now.saturating_duration_since(*since) >= duration)
            {
                state.outgoing = None;
            }
            (state.outgoing.clone(), state.height.clone())
        });
        let travel = height.get();
        let current = (self.frame)(window, cx);
        let viewport = div()
            .grid()
            .grid_cols_max_content(1)
            .grid_rows(1)
            .min_w_0()
            .overflow_hidden();
        let Some((leaving, since)) = prior else {
            return viewport.child(cell(current, 0., 1., Some(height)));
        };
        window.request_animation_frame();
        let t = convert::ease_at(
            ease,
            (now.saturating_duration_since(since).as_secs_f32() / duration.as_secs_f32()).min(1.),
        );
        // `translateY(-100%)` out, `translateY(100%)` in.
        viewport
            .child(cell(leaving(window, cx), -travel * t, 1. - t, None))
            .child(cell(current, travel * (1. - t), t, Some(height)))
    }
}
