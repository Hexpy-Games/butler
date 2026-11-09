//! DS AnimatedNumber (AnimatedNumber.tsx / AnimatedNumber.module.css): a number that counts to
//! its new value over `--motion-deliberate` on the decelerate easing (reduced motion: an
//! instant swap with a short fade). Tabular numerals, and a start and an end sizer in one grid
//! cell, keep the width stable while counting; the start sizer is released when the count ends.
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, ElementId, FontFeatures, FontWeight, IntoElement, ParentElement as _, RenderOnce,
    Styled as _, Window, div, px,
};

use super::context::Ds;
use super::convert;
use super::motion;
use super::typo::Role;
use crate::tokens::{Duration as DsDuration, Easing};

/// Formats every shown value.
pub type Format = Rc<dyn Fn(f64) -> String>;

/// The default format: digits grouped by thousands (`Intl.NumberFormat` in English and Korean).
pub fn grouped(value: f64) -> String {
    let digits = format!("{:.0}", value.abs());
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    if value < 0. && digits != "0" {
        out.insert(0, '-');
    }
    out
}

#[derive(Clone, Copy)]
enum Run {
    Count { from: f64, since: u32 },
    Fade { since: u32 },
}

struct State {
    target: f64,
    shown: f64,
    /// The value the start sizer holds the width of while counting.
    sizer: f64,
    run: Option<Run>,
}

#[derive(IntoElement)]
pub struct AnimatedNumber {
    id: ElementId,
    value: f64,
    format: Format,
    role: Option<Role>,
}

impl AnimatedNumber {
    pub fn new(id: impl Into<ElementId>, value: f64) -> Self {
        Self {
            id: id.into(),
            value,
            format: Rc::new(grouped),
            role: None,
        }
    }

    pub fn format(mut self, format: impl Fn(f64) -> String + 'static) -> Self {
        self.format = Rc::new(format);
        self
    }

    /// Takes a type role's size, line height and weight (the number inside a `Typo` of that role).
    pub fn role(mut self, role: Role) -> Self {
        self.role = Some(role);
        self
    }
}

/// The timing of a count and of the reduced-motion fade.
struct Timing {
    count: std::time::Duration,
    fade: std::time::Duration,
    ease: crate::tokens::Ease,
}

/// Moves the run to `now`: the value shown, the width sizer, and the fade's progress.
fn step(
    state: &mut State,
    now: u32,
    timing: &Timing,
    value: f64,
    reduced: bool,
) -> (f64, f64, Option<Run>, bool) {
    match state.run {
        Some(Run::Count { from, since }) => {
            let elapsed = std::time::Duration::from_millis(u64::from(now.wrapping_sub(since)));
            if elapsed >= timing.count {
                state.shown = state.target;
                state.sizer = state.target;
                state.run = None;
            } else {
                let t = elapsed.as_secs_f32() / timing.count.as_secs_f32();
                let at = f64::from(convert::ease_at(timing.ease, t));
                let value = from + (state.target - from) * at;
                let whole = from.fract() == 0. && state.target.fract() == 0.;
                state.shown = if whole { value.round() } else { value };
            }
        }
        Some(Run::Fade { since })
            if std::time::Duration::from_millis(u64::from(now.wrapping_sub(since)))
                >= timing.fade =>
        {
            state.run = None;
        }
        Some(Run::Fade { .. }) | None => {}
    }
    let changed = value != state.target;
    if changed {
        let from = state.shown;
        state.target = value;
        if reduced {
            state.shown = value;
            state.sizer = value;
            state.run = Some(Run::Fade { since: now });
        } else {
            state.sizer = from;
            state.run = Some(Run::Count { from, since: now });
        }
    }
    (state.shown, state.sizer, state.run, changed)
}

/// A type role's size, line height, weight and letter spacing on `root`.
fn with_role(mut root: gpui::Div, role: Option<Role>, ds: &Ds) -> gpui::Div {
    root.text_style().font_features = Some(FontFeatures(Arc::new(vec![("tnum".to_owned(), 1)])));
    let Some(tokens) = role.and_then(Role::tokens) else {
        return root;
    };
    root = root
        .text_size(ds.len(tokens.size))
        .line_height(ds.len(tokens.line_height))
        .font_weight(FontWeight(ds.number(tokens.weight)))
        .font_family(ds.body_font().clone());
    let spacing = ds.number(tokens.letter_spacing);
    if spacing != 0. {
        root.text_style().letter_spacing = Some(px(spacing));
    }
    root
}

impl RenderOnce for AnimatedNumber {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = gpui::animation_time_ms();
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| State {
            target: self.value,
            shown: self.value,
            sizer: self.value,
            run: None,
        });
        let ds = Ds::get(cx);
        let reduced = ds.reduced_motion();
        let timing = Timing {
            count: ds.duration(DsDuration::MotionDeliberate),
            fade: ds.duration(DsDuration::MotionFast),
            ease: ds.tokens().ease(Easing::MotionEaseDecelerate),
        };
        let (shown, sizer, run, changed) = state.update(cx, |state, _| {
            step(state, now, &timing, self.value, reduced)
        });
        if changed {
            motion::wake_after(window, cx, if reduced { timing.fade } else { timing.count });
        }
        let format = &self.format;
        let cell = |text: String| {
            div()
                .col_start(1)
                .row_start(1)
                .text_right()
                .whitespace_nowrap()
                .child(text)
        };
        let mut stack = div()
            .relative()
            .grid()
            .grid_cols_max_content(1)
            .grid_rows(1)
            .child(cell(format(sizer)).invisible())
            .child(cell(format(self.value)).invisible());
        match run {
            Some(Run::Count { from, since }) => {
                let linear = motion::Timing::linear(timing.count);
                let n = linear.ms().saturating_mul(60).div_ceil(1000);
                let whole = from.fract() == 0. && self.value.fract() == 0.;
                stack = stack.children((0..n).map(|i| {
                    let progress = convert::ease_at(timing.ease, (i + 1) as f32 / n as f32);
                    let value = from + (self.value - from) * f64::from(progress);
                    let value = if whole { value.round() } else { value };
                    div()
                        .absolute()
                        .size_full()
                        .motion(gpui::LayerMotion {
                            visible: (i as f32 / n as f32, (i + 1) as f32 / n as f32),
                            ..linear.motion(since)
                        })
                        .child(cell(format(value)))
                }));
            }
            Some(Run::Fade { since }) => {
                let fade = motion::Transition {
                    from: 0.,
                    to: 1.,
                    start_ms: since,
                };
                stack = stack.child(fade.apply(
                    cell(format(shown)),
                    &motion::Timing::linear(timing.fade),
                    &motion::Props {
                        opacity: Some((0., 1.)),
                        ..Default::default()
                    },
                ));
            }
            None => stack = stack.child(cell(format(shown))),
        }
        with_role(
            div().flex().flex_none().whitespace_nowrap().child(stack),
            self.role,
            Ds::get(cx),
        )
    }
}
