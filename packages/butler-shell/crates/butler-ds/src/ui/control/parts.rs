//! The value types a control is described with, its hover state and the harness anchors.
use std::time::Instant;

use gpui::{App, Hsla, SharedString};

use crate::ui::convert;

/// How a control is disabled.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Disabled {
    #[default]
    No,
    /// `disabled`: not focusable, no activation.
    Native,
    /// `aria-disabled="true"`: focusable and hoverable, activation blocked.
    Aria,
}

impl Disabled {
    pub fn is_on(self) -> bool {
        self != Self::No
    }
}

/// What disabled looks like.
#[derive(Clone, Copy, Debug)]
pub enum DisabledLook {
    /// The opacity family: the whole control fades (cursor default).
    Opacity(f32),
    /// The text-tone family: the colour is `--interactive-disabled-fg`, cursor not-allowed.
    Text,
}

/// A value at rest, on hover and while pressed.
#[derive(Clone, Copy, Debug)]
pub struct Blend {
    pub rest: Hsla,
    pub hover: Hsla,
    pub active: Option<Hsla>,
}

impl Blend {
    pub fn flat(color: Hsla) -> Self {
        Self {
            rest: color,
            hover: color,
            active: None,
        }
    }

    pub fn hover(rest: Hsla, hover: Hsla) -> Self {
        Self {
            rest,
            hover,
            active: None,
        }
    }

    pub(super) fn at(self, hover: f32, pressed: bool) -> Hsla {
        match (pressed, self.active) {
            (true, Some(active)) => active,
            _ => convert::mix(self.hover, self.rest, hover),
        }
    }
}

/// The focus indicator of a control.
#[derive(Clone, Copy, Debug, Default)]
pub enum Ring {
    /// `box-shadow: var(--focus-ring)`: a 2px spread following the radius.
    #[default]
    Spread,
    /// `outline: 2px solid ring-colour` at this offset (Clickable text, GlyphToggle).
    Outline(f32),
}

/// Numbers the controls in render order (`control-<n>` geometry anchors), so a harness can
/// address the nth control of a page like the React viewer's DOM order. Reset once per frame.
#[derive(Default)]
struct Anchors {
    next: std::cell::Cell<usize>,
    handles: std::cell::RefCell<Vec<(usize, gpui::FocusHandle)>>,
}

impl gpui::Global for Anchors {}

/// Restarts the numbering; the page host calls it before it renders its controls.
pub fn reset_anchors(cx: &mut App) {
    let anchors = cx.default_global::<Anchors>();
    anchors.next.set(0);
    anchors.handles.borrow_mut().clear();
    crate::ui::focus::reset_hand_off(cx);
    crate::ui::text::reset(cx);
}

/// The focus handle of control `n` of the last frame (`None` when it cannot take focus).
pub fn focus_handle(cx: &App, n: usize) -> Option<gpui::FocusHandle> {
    let anchors = cx.try_global::<Anchors>()?;
    let handles = anchors.handles.borrow();
    handles
        .iter()
        .find(|(index, _)| *index == n)
        .map(|(_, handle)| handle.clone())
}

pub(crate) fn next_anchor(cx: &mut App, handle: Option<&gpui::FocusHandle>) -> SharedString {
    let anchors = cx.default_global::<Anchors>();
    let n = anchors.next.get();
    anchors.next.set(n + 1);
    if let Some(handle) = handle {
        anchors.handles.borrow_mut().push((n, handle.clone()));
    }
    SharedString::from(format!("control-{n}"))
}

/// `top` painted over `bottom` (source-over, as stacked backgrounds).
pub fn over(top: Hsla, bottom: Hsla) -> Hsla {
    let (t, b) = (gpui::hsla_to_rgba(top), gpui::hsla_to_rgba(bottom));
    let alpha = t.alpha + b.alpha * (1. - t.alpha);
    if alpha <= 0. {
        return gpui::transparent_black();
    }
    let channel = |x: f32, y: f32| (x * t.alpha + y * b.alpha * (1. - t.alpha)) / alpha;
    gpui::rgb_to_hsla(gpui::Rgba::new(
        channel(t.red, b.red),
        channel(t.green, b.green),
        channel(t.blue, b.blue),
        alpha,
    ))
}

/// Text decoration of a control's label.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Underline {
    #[default]
    Never,
    Always,
    OnHover,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Width {
    #[default]
    Auto,
    Fixed(f32),
    /// `width: 100%`.
    Full,
    /// Fills a column's cross axis (a stretched row, or `calc(100% + ..)` with its bleed
    /// margins): the box is not shrink-wrapped.
    Stretch,
    /// `flex: 1 1 0` with `min-width: 0`: equal shares of a row.
    Grow,
}

/// Hover and press state of one control.
#[derive(Default)]
pub(crate) struct State {
    pub(crate) hovered: bool,
    pub(super) pressed: bool,
    /// Hover blend 0..=1 and the animation toward `hovered`.
    pub(crate) mix: f32,
    from: f32,
    since: Option<Instant>,
}

impl State {
    /// At rest on the target (`on`: 1, else 0).
    pub(crate) fn settled(on: bool) -> Self {
        Self {
            hovered: on,
            mix: f32::from(u8::from(on)),
            from: f32::from(u8::from(on)),
            ..Self::default()
        }
    }

    pub(crate) fn retarget(&mut self, hovered: bool, now: Instant, at: f32) {
        self.from = at;
        self.hovered = hovered;
        self.since = Some(now);
    }

    /// The hover blend now, and whether it is still moving.
    pub(crate) fn sample(
        &mut self,
        now: Instant,
        duration: std::time::Duration,
        ease: &impl Fn(f32) -> f32,
    ) -> (f32, bool) {
        let to = if self.hovered { 1. } else { 0. };
        let Some(since) = self.since else {
            return (to, false);
        };
        let total = duration.as_secs_f32();
        let elapsed = now.saturating_duration_since(since).as_secs_f32();
        if total <= 0. || elapsed >= total {
            self.since = None;
            self.mix = to;
            self.from = to;
            return (to, false);
        }
        let value = self.from + (to - self.from) * ease(elapsed / total);
        self.mix = value;
        (value, true)
    }
}
