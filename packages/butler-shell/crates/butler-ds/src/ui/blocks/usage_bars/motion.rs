//! useUsageBarsMotion.ts: column motion. A first show or a new bucket count grows the columns
//! from the baseline, staggered; the same count with new values eases each column from the
//! height it painted to its new one (FLIP). An update in flight starts from what is painted now.
//! Reduced motion draws the final heights at once.
use std::time::{Duration, Instant};

use gpui::{App, ElementId, Window};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::Timing;

/// Per-bar grow delay of the approved mockups; the whole stagger stays within `--motion-slow`.
const GROW_STAGGER: Duration = Duration::from_millis(12);

struct State {
    /// The targets the last render held.
    targets: Vec<f32>,
    /// Where each column started, and when the run began.
    from: Vec<f32>,
    since: Instant,
    grow: bool,
}

/// The height (px) each column is drawn at now, heading for `targets`.
pub(super) fn heights(
    id: &ElementId,
    targets: &[f32],
    window: &mut Window,
    cx: &mut App,
) -> Vec<f32> {
    let now = cx.background_executor().now();
    let (jump, slow, deliberate) = {
        let ds = Ds::get(cx);
        (
            ds.reduced_motion(),
            ds.duration(DsDuration::MotionSlow),
            ds.duration(DsDuration::MotionDeliberate),
        )
    };
    let (standard, decelerate) = {
        let ds = Ds::get(cx);
        (
            Timing::token(ds, DsDuration::MotionSlow, Easing::MotionEaseStandard),
            Timing::token(
                ds,
                DsDuration::MotionDeliberate,
                Easing::MotionEaseDecelerate,
            ),
        )
    };
    let state = window.use_keyed_state((id.clone(), "motion"), cx, |_, _| None::<State>);
    let (painted, moving) = state.update(cx, |state, _| {
        let at = |state: &State, now: Instant| {
            sample(state, now, (slow, deliberate), (&standard, &decelerate))
        };
        if let Some(current) = state.as_ref() {
            let painted = at(current, now).0;
            if current.targets != targets {
                let same = current.targets.len() == targets.len();
                *state = Some(State {
                    targets: targets.to_vec(),
                    from: if same {
                        painted
                    } else {
                        vec![0.; targets.len()]
                    },
                    since: now,
                    grow: !same,
                });
            }
        } else {
            *state = Some(State {
                targets: targets.to_vec(),
                from: vec![0.; targets.len()],
                since: now,
                grow: true,
            });
        }
        match state.as_ref() {
            Some(current) if !jump => at(current, now),
            _ => (targets.to_vec(), false),
        }
    });
    if moving {
        window.request_animation_frame();
    }
    painted
}

fn sample(
    state: &State,
    now: Instant,
    (slow, deliberate): (Duration, Duration),
    (standard, decelerate): (&Timing, &Timing),
) -> (Vec<f32>, bool) {
    let elapsed = now.saturating_duration_since(state.since);
    let step = GROW_STAGGER.min(slow / u32::try_from(state.targets.len().max(1)).unwrap_or(1));
    let mut moving = false;
    let heights = state
        .targets
        .iter()
        .zip(&state.from)
        .enumerate()
        .map(|(index, (to, from))| {
            let (delay, duration, timing) = if state.grow {
                (
                    step * u32::try_from(index).unwrap_or(0),
                    deliberate,
                    decelerate,
                )
            } else {
                (Duration::ZERO, slow, standard)
            };
            let Some(run) = elapsed.checked_sub(delay) else {
                moving = true;
                return *from;
            };
            if run >= duration || (to - from).abs() < 0.5 {
                return *to;
            }
            moving = true;
            from + (to - from) * timing.ease(run.as_secs_f32() / duration.as_secs_f32())
        })
        .collect();
    (heights, moving)
}
