//! useUsageBarsMotion.ts: column motion. A first show or a new bucket count grows the columns
//! from the baseline, staggered; the same count with new values eases each column from the
//! height it painted to its new one (FLIP). An update in flight starts from what is painted now.
//! Reduced motion draws the final heights at once.
use std::time::Duration;

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, Transition};
use gpui::{App, ElementId, Window, animation_time_ms};

const GROW_STAGGER: Duration = Duration::from_millis(12);

struct State {
    targets: Vec<f32>,
    bars: Vec<(Transition, Timing)>,
}

/// Retained clip motion for each column, in pixels above the baseline.
pub(super) fn heights(
    id: &ElementId,
    targets: &[f32],
    window: &mut Window,
    cx: &mut App,
) -> Vec<(Transition, Timing)> {
    let ds = Ds::get(cx);
    let jump = ds.reduced_motion();
    let standard = Timing::token(ds, DsDuration::MotionSlow, Easing::MotionEaseStandard);
    let decelerate = Timing::token(
        ds,
        DsDuration::MotionDeliberate,
        Easing::MotionEaseDecelerate,
    );
    let state = window.use_keyed_state((id.clone(), "motion"), cx, |_, _| State {
        targets: Vec::new(),
        bars: Vec::new(),
    });
    state.update(cx, |state, _| {
        if state.targets != targets {
            let same = state.targets.len() == targets.len();
            let now = animation_time_ms();
            let timing = if same { standard } else { decelerate };
            let step = GROW_STAGGER
                .min(standard.duration / u32::try_from(targets.len().max(1)).unwrap_or(1));
            let bars = targets
                .iter()
                .enumerate()
                .map(|(index, &to)| {
                    let from = if jump {
                        to
                    } else if same {
                        let (previous, time) = state.bars[index];
                        let p = previous.motion(&time).progress(now);
                        previous.from + (previous.to - previous.from) * p
                    } else {
                        0.
                    };
                    let delay = if same || jump {
                        0
                    } else {
                        u32::try_from((step * u32::try_from(index).unwrap_or(0)).as_millis())
                            .unwrap_or(0)
                    };
                    (
                        Transition {
                            from,
                            to,
                            start_ms: if jump {
                                now.wrapping_sub(timing.ms())
                            } else {
                                now.wrapping_add(delay)
                            },
                        },
                        timing,
                    )
                })
                .collect();
            *state = State {
                targets: targets.to_vec(),
                bars,
            };
        }
        state.bars.clone()
    })
}
