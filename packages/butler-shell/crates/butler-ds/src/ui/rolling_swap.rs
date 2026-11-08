//! DS RollingSwap (RollingSwap.tsx / RollingSwap.module.css): one line of content that rolls
//! to the next when its key changes. The old frame leaves upward while the new one comes in
//! from below, over `--adaptive-panel-duration` on `--adaptive-panel-easing`, clipped to the
//! viewport. Reduced motion, or `motion(false)`, swaps at once.
use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, canvas, div, px,
};

use super::context::Ds;
use super::motion::{self, Props, Timing, Transition};
use crate::tokens::{Duration as DsDuration, Easing};

/// How a frame's content is drawn; kept so the frame that leaves can be drawn once more.
pub type Frame = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

struct State {
    key: SharedString,
    frame: Frame,
    outgoing: Option<(Frame, u32)>,
    /// The height of the frame last painted: a frame travels its own height.
    height: Rc<Cell<f32>>,
}

#[derive(IntoElement)]
pub struct RollingSwap {
    id: ElementId,
    item_key: SharedString,
    motion: bool,
    /// The track fills the viewport's width (`display: grid` in a block); it shrink-wraps its
    /// content otherwise, as in a flex row.
    fill: bool,
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
            fill: false,
            frame: Rc::new(frame),
        }
    }

    pub fn motion(mut self, motion: bool) -> Self {
        self.motion = motion;
        self
    }

    /// The swap sits in a block and fills its width.
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }
}

/// A frame in the viewport's one grid cell, `dy` px down from its place.
fn cell(content: AnyElement, dy: f32, opacity: f32, height: Option<Rc<Cell<f32>>>) -> gpui::Div {
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
}

impl RenderOnce for RollingSwap {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = gpui::animation_time_ms();
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| State {
            key: self.item_key.clone(),
            frame: self.frame.clone(),
            outgoing: None,
            height: Rc::new(Cell::new(0.)),
        });
        let ds = Ds::get(cx);
        let rolls = self.motion && !ds.reduced_motion();
        let timing = Timing::token(
            ds,
            DsDuration::AdaptivePanelDuration,
            Easing::AdaptivePanelEasing,
        );
        let changed = state.read(cx).key != self.item_key;
        if changed && rolls {
            motion::wake_after(window, cx, timing.duration);
        }
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
                .is_some_and(|(_, since)| now.wrapping_sub(*since) >= timing.ms())
            {
                state.outgoing = None;
            }
            (state.outgoing.clone(), state.height.clone())
        });
        let travel = height.get();
        let current = (self.frame)(window, cx);
        let viewport = div().grid().grid_rows(1).min_w_0().overflow_hidden();
        let viewport = if self.fill {
            viewport.grid_cols(1)
        } else {
            viewport.grid_cols_max_content(1)
        };
        let Some((leaving, since)) = prior else {
            return viewport.child(cell(current, 0., 1., Some(height)));
        };
        let roll = Transition {
            from: 0.,
            to: 1.,
            start_ms: since,
        };
        viewport
            .child(roll.apply(
                cell(leaving(window, cx), 0., 1., None),
                &timing,
                &Props {
                    opacity: Some((1., 0.)),
                    offset: Some((
                        gpui::point(px(0.), px(0.)),
                        gpui::point(px(0.), px(-travel)),
                    )),
                    ..Default::default()
                },
            ))
            .child(roll.apply(
                cell(current, 0., 1., Some(height)),
                &timing,
                &Props {
                    opacity: Some((0., 1.)),
                    offset: Some((gpui::point(px(0.), px(travel)), gpui::point(px(0.), px(0.)))),
                    ..Default::default()
                },
            ))
    }
}
