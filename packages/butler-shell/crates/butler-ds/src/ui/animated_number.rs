//! DS AnimatedNumber (AnimatedNumber.tsx / AnimatedNumber.module.css): a number that counts to
//! its new value over `--motion-deliberate` on the decelerate easing (reduced motion: an
//! instant swap with a short fade). Tabular numerals, and a start and an end sizer in one grid
//! cell, keep the width stable while counting; the start sizer is released when the count ends.
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use gpui::{
    App, ElementId, FontFeatures, FontWeight, IntoElement, ParentElement as _, RenderOnce,
    Styled as _, Window, div, px,
};

use super::context::Ds;
use super::convert;
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

enum Run {
    Count { from: f64, since: Instant },
    Fade { since: Instant },
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
fn step(state: &mut State, now: Instant, timing: &Timing) -> (f64, f64, Option<f32>) {
    match state.run {
        Some(Run::Count { from, since }) => {
            let elapsed = now.saturating_duration_since(since);
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
        Some(Run::Fade { since }) if now.saturating_duration_since(since) >= timing.fade => {
            state.run = None;
        }
        Some(Run::Fade { .. }) | None => {}
    }
    let fading = match state.run {
        Some(Run::Fade { since }) => {
            Some(now.saturating_duration_since(since).as_secs_f32() / timing.fade.as_secs_f32())
        }
        _ => None,
    };
    (state.shown, state.sizer, fading)
}

/// A type role's size, line height, weight and letter spacing on `root`.
fn with_role(mut root: gpui::Div, role: Role, ds: &Ds) -> gpui::Div {
    let Some(tokens) = role.tokens() else {
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
        let now = cx.background_executor().now();
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
        let ((shown, sizer, fading), moving) = state.update(cx, |state, _| {
            if self.value != state.target {
                let from = state.shown;
                state.target = self.value;
                if reduced {
                    state.shown = self.value;
                    state.sizer = self.value;
                    state.run = Some(Run::Fade { since: now });
                } else {
                    state.sizer = from;
                    state.run = Some(Run::Count { from, since: now });
                }
            }
            let shown = step(state, now, &timing);
            (shown, state.run.is_some())
        });
        if moving {
            window.request_animation_frame();
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
        let value = cell(format(shown)).opacity(fading.unwrap_or(1.).clamp(0., 1.));
        let stack = div()
            .grid()
            .grid_cols_max_content(1)
            .grid_rows(1)
            .child(cell(format(sizer)).invisible())
            .child(cell(format(self.value)).invisible())
            .child(value);
        let mut root = div().flex().flex_none().whitespace_nowrap().child(stack);
        root.text_style().font_features =
            Some(FontFeatures(Arc::new(vec![("tnum".to_owned(), 1)])));
        match self.role {
            Some(role) => with_role(root, role, Ds::get(cx)),
            None => root,
        }
    }
}
