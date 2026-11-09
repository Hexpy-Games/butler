//! The phase rail of a WorkerActivityRow (`.phaseRail`): five bars with their labels. The active
//! step pulses; a worker that has finished shows every reached step quiet.
use gpui::{
    AnyElement, App, Hsla, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Duration as DsDuration, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::motion::{Loop, Props, Timing, Transition, mounted_at};

const PHASES: [&str; 5] = [
    "orienting",
    "planning",
    "executing",
    "verifying",
    "reporting",
];
const LABELS: [&str; 5] = ["Orient", "Plan", "Execute", "Verify", "Report"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Pending,
    Active,
    Done,
    Failed,
    Cancelled,
}

/// The public phase a backend phase shows as (`publicPhaseFor`).
fn public_phase(phase: &str) -> Option<usize> {
    let name = match phase {
        "inspecting" => "planning",
        "committing" | "consolidating" => "verifying",
        other => other,
    };
    PHASES.iter().position(|known| *known == name)
}

fn current(phase: &str) -> Option<usize> {
    if phase == "complete" {
        Some(PHASES.len())
    } else {
        public_phase(phase)
    }
}

fn terminal(phase: &str) -> bool {
    matches!(phase, "complete" | "failed" | "cancelled")
}

/// The state of rail step `index` (`phaseState`).
fn step(index: usize, current: Option<usize>, phase: &str) -> Step {
    let terminal = terminal(phase);
    let at = current.unwrap_or(0);
    if matches!(phase, "failed" | "cancelled") && index == at {
        return if phase == "failed" {
            Step::Failed
        } else {
            Step::Cancelled
        };
    }
    match current {
        Some(now) if terminal && now >= PHASES.len() => Step::Done,
        Some(now) if index < now => Step::Done,
        Some(now) if index == now => Step::Active,
        _ => Step::Pending,
    }
}

/// The rail: five bars and their labels.
pub(super) fn rail(
    phase: &str,
    finishing: Option<(Transition, Timing)>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let now = current(phase);
    let start = mounted_at("worker-rail-pulse", window, cx);
    let ds = Ds::get(cx);
    let spaced = ds.len(Length::Space1);
    let finished = terminal(phase);
    let bars = PHASES.iter().enumerate().map(|(index, _)| {
        let state = step(index, now, phase);
        let (fill, ink, _, _) = bar_look(state, finished, (false, 0.), ds);
        let mut bar = div().h(px(3.)).rounded(ds.len(Length::RadiusPill)).bg(fill);
        if state == Step::Active && !finished && Loop::Decorative.runs(ds) {
            let timing = Timing::linear(ds.duration(DsDuration::PulseDuration));
            bar = bar.motion(gpui::LayerMotion {
                repeat: gpui::MotionRepeat::Loop,
                opacity: (0.68, 1.),
                scale: (1., 1.35),
                easing: gpui::MotionEasing::linear(&[(0., 0.), (0.5, 1.), (1., 0.)]),
                ..timing.motion(start)
            });
        }
        if let Some((value, timing)) = finishing.filter(|_| index == PHASES.len() - 1) {
            bar = value.apply(
                bar,
                &timing,
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(3.))
            .min_w_0()
            .flex_1()
            .text_color(ink)
            .child(bar)
            .child(
                div()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(ds.len(Length::FontSize1))
                    .line_height(ds.len(Length::TypoCaptionLineHeight))
                    .child(LABELS[index]),
            )
    });
    div()
        .flex()
        .gap(spaced)
        .pt(spaced)
        .w_full()
        .children(bars)
        .into_any_element()
}

/// A bar's fill, its label ink, its `scaleY` and its opacity: `pulse` is `(runs, phase)` of the
/// active bar's loop (`worker-phase-pulse`, opacity .68 to 1 and scaleY 1 to 1.35 and back).
fn bar_look(state: Step, finished: bool, pulse: (bool, f32), ds: &Ds) -> (Hsla, Hsla, f32, f32) {
    let (active, line) = (ds.color(Color::WorkerActive), ds.color(Color::Line));
    let (tertiary, secondary) = (
        ds.color(Color::TextTertiary),
        ds.color(Color::TextSecondary),
    );
    let (mut fill, mut ink, mut scale, mut opacity) = (line, tertiary, 1., 1.);
    match state {
        Step::Done => fill = convert::mix(active, line, 0.64),
        Step::Active => {
            fill = active;
            ink = secondary;
            if pulse.0 && !finished {
                let wave = 1. - (pulse.1 * 2. - 1.).abs();
                opacity = 0.68 + 0.32 * wave;
                scale = 1. + 0.35 * wave;
            }
        }
        Step::Failed => {
            fill = ds.color(Color::Danger);
            ink = fill;
        }
        Step::Cancelled => {
            fill = tertiary;
            ink = secondary;
        }
        Step::Pending => {}
    }
    if finished && matches!(state, Step::Active | Step::Done) {
        fill = tertiary;
        scale = 1.;
        opacity = 1.;
    }
    (fill, ink, scale, opacity)
}
