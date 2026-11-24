//! The rows of a card that arrives by a morph (`riseRows`, setupWizardMorph.ts:33-40).
use std::time::Duration;

use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, point, px,
};

use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{self, Props, Timing, Transition};

fn row_transition(index: u32, since: u32, ds: &Ds) -> (Transition, Timing) {
    let decelerate = Easing::MotionEaseDecelerate;
    let base = Timing::token(ds, DsDuration::MotionBase, decelerate);
    let lead = Timing::token(ds, DsDuration::MotionMorphRows, decelerate).ms();
    let step = Timing::token(ds, DsDuration::MotionStaggerRow, decelerate).ms();
    let rise = Transition {
        from: 0.,
        to: 1.,
        start_ms: since.wrapping_add(lead + index * step),
    };
    (rise, base)
}

/// Row `index` of the card whose morph began at `since`: it fades in and rises
/// `--motion-distance-sm` over `--motion-base`, from `--motion-morph-rows` plus one
/// `--motion-stagger-row` per row before it. A row that has arrived is returned as it is, so
/// nothing stays in the tree at rest.
pub(in crate::ui::blocks) fn rise_row(
    row: AnyElement,
    index: u32,
    since: u32,
    ds: &Ds,
) -> AnyElement {
    let (rise, base) = row_transition(index, since, ds);
    if !rise.moving(&base) {
        return row;
    }
    // The wrapper lays its one row out as the card's column does (a stretching flex column).
    let wrapper = div().flex().flex_col().min_w_0().child(row);
    let props = Props {
        opacity: Some((0., 1.)),
        offset: Some((
            point(px(0.), ds.len(Length::MotionDistanceSm)),
            point(px(0.), px(0.)),
        )),
        ..Default::default()
    };
    rise.apply(wrapper, &base, &props).into_any_element()
}

/// Renders the calling view once more when the last of `count` rows has arrived, so their
/// wrappers leave the tree. Call it after the rows went through [`rise_row`].
pub(in crate::ui::blocks) fn settle_rows(
    count: u32,
    since: u32,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(index) = count.checked_sub(1) else {
        return;
    };
    let (last, base) = row_transition(index, since, Ds::get(cx));
    let now = gpui::animation_time_ms();
    if last.moving(&base) {
        let delay = last.start_ms.wrapping_add(base.ms()).wrapping_sub(now);
        motion::wake_after(window, cx, Duration::from_millis(u64::from(delay)));
    }
}
