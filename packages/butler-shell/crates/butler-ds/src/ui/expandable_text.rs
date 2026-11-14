//! DS ExpandableText (ExpandableText.tsx / ExpandableText.module.css): text clamped to
//! `collapsed_lines` that, only when it really overflows, becomes one toggle and grows in place.
//! The box animates its own measured height (`--motion-base`, standard easing; a collapse
//! `--motion-exit-base`, accelerate) and the clamp is lifted at the start of an expand and put
//! back at the end of a collapse, so the first line stays put. Reduced motion: instant. Optional
//! `meta` is a caption line above the text. The open cue is the disclosure chevron (ChevronRight,
//! `sm`, `--text-tertiary`, in a line-high slot kept in every row, empty when the text fits) that
//! turns 90 degrees to point down over `--motion-fast`.
use std::time::Instant;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Window, canvas, div, px,
};

use super::Icon;
use super::context::{Ds, Lang};
use super::control::{Blend, Control, Ring, Width};
use super::icon::{IconSize, icon};
use super::motion::{Props, Timing, Transition, transition};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};

/// A box height in motion: grows to `to` over `--motion-base` or shrinks over `--motion-exit-base`.
struct Resize {
    to: f32,
    since: Instant,
    collapsing: bool,
}

struct State {
    expanded: bool,
    /// The line clamp applies (it is lifted from the start of an expand to the end of a collapse).
    clamped: bool,
    /// The height of the whole text at the current width, from the hidden measuring copy.
    full: f32,
    /// The box height as last laid out (the start of the next resize).
    shown: f32,
    resize: Option<Resize>,
}

#[derive(IntoElement)]
pub struct ExpandableText {
    id: ElementId,
    text: SharedString,
    collapsed_lines: u8,
    meta: Option<SharedString>,
}

impl ExpandableText {
    /// Plain text: line breaks are kept and long words or URLs wrap anywhere.
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            collapsed_lines: 1,
            meta: None,
        }
    }

    /// Lines shown while collapsed: 1 (default), 2 or 3.
    pub fn collapsed_lines(mut self, lines: u8) -> Self {
        self.collapsed_lines = lines.clamp(1, 3);
        self
    }

    /// A short caption line above the text (scope, date).
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }
}

/// The body text style: `--typo-body-*` with the break rules of `.text`.
fn body_text(text: SharedString, ds: &Ds) -> gpui::Div {
    let el = div()
        .min_w_0()
        .overflow_wrap(gpui::OverflowWrap::Anywhere)
        .text_size(ds.len(Length::TypoBodySize))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .child(text);
    // DS: ExpandableText.module.css:63 `overflow-wrap: anywhere`, over the root's `:lang(ko)`.
    if ds.lang() == Lang::Ko {
        el.word_break(gpui::WordBreak::KeepAll)
    } else {
        el
    }
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// What one frame draws of the state.
struct Step {
    /// The box's height while it resizes.
    height: Option<f32>,
    /// The chevron's turn, 0 to 1.
    clamped: bool,
    full: f32,
}

/// Advances the resize and the chevron to `now`.
fn step(state: &Entity<State>, now: Instant, collapsed: f32, cx: &mut App) -> Step {
    let ds = Ds::get(cx);
    let (expand, exit) = (
        ds.duration(DsDuration::MotionBase),
        ds.duration(DsDuration::MotionExitBase),
    );
    state.update(cx, |s, _| {
        if let Some(resize) = &s.resize
            && now.saturating_duration_since(resize.since)
                >= if resize.collapsing { exit } else { expand }
        {
            // A collapse puts the clamp back only once the box is down.
            s.clamped |= resize.collapsing;
            s.resize = None;
        }
        let height = s.resize.as_ref().map(|resize| resize.to);
        s.shown = height.unwrap_or(if s.clamped { collapsed } else { s.full });
        Step {
            height,
            clamped: s.clamped,
            full: s.full,
        }
    })
}

/// The hidden copy of the whole text: its height at the box's width tells whether the text
/// overflows its collapsed lines.
fn measuring_copy(text: SharedString, state: &Entity<State>, ds: &Ds) -> gpui::Div {
    let probe = state.clone();
    div()
        .absolute()
        .top_0()
        .left_0()
        .w_full()
        .invisible()
        .child(body_text(text, ds))
        .child(
            canvas(
                move |bounds, _, cx| {
                    let height = f32::from(bounds.size.height);
                    probe.update(cx, |s, cx| {
                        if (s.full - height).abs() > 0.5 {
                            s.full = height;
                            cx.notify();
                        }
                    });
                },
                |_, (), _, _| {},
            )
            .absolute()
            .size_full(),
        )
}

/// A click on the row: expand, or collapse back to the clamped height.
fn toggle(state: Entity<State>, collapsed: f32, reduced: bool) -> Handler {
    Rc::new(move |_, window, cx| {
        let now = cx.background_executor().now();
        let ds = Ds::get(cx);
        let timing = if state.read(cx).expanded {
            Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate)
        } else {
            Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard)
        };
        if !reduced {
            window.animate_layout(timing.ms());
        }
        state.update(cx, |s, cx| {
            let open = !s.expanded;
            s.expanded = open;
            let from = s.shown;
            let to = if open { s.full } else { collapsed };
            if open {
                s.clamped = false;
            }
            s.resize = (!reduced && (from - to).abs() > 0.5).then_some(Resize {
                to,
                since: now,
                collapsing: !open,
            });
            if s.resize.is_none() && !open {
                s.clamped = true;
            }
            cx.notify();
        });
        let state = state.clone();
        crate::ui::motion::delay(window, cx, timing.duration, move |_, cx| {
            state.update(cx, |_, cx| cx.notify());
        });
    })
}

/// The caption line above the row, when there is one.
fn stack(
    meta: Option<SharedString>,
    frame: gpui::Stateful<gpui::Div>,
    (turn, turn_timing): (Transition, Timing),
    overflows: bool,
    ds: &Ds,
) -> AnyElement {
    let chevron = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(ds.len(Length::TypoBodyLineHeight))
        .text_color(ds.color(Color::TextTertiary))
        .children(overflows.then(|| {
            turn.apply(
                div().child(icon(Icon::ChevronRight, IconSize::Sm, ds)),
                &turn_timing,
                &Props {
                    rotation: Some((0., std::f32::consts::FRAC_PI_2)),
                    ..Default::default()
                },
            )
        }));
    let row = div()
        .flex()
        .items_start()
        .gap(ds.len(Length::SpaceXs))
        .child(div().flex_1().min_w_0().child(frame))
        .child(chevron);

    div()
        .flex()
        .flex_col()
        .min_w_0()
        .w_full()
        .gap(ds.len(Length::SpaceXs))
        .children(meta.map(|meta| {
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_color(ds.color(Color::TextSecondary))
                .text_size(ds.len(Length::TypoCaptionSize))
                .line_height(ds.len(Length::TypoCaptionLineHeight))
                .child(meta)
        }))
        .child(row)
        .into_any_element()
}

/// The row as the toggle: a block control with the default focus ring offset by its room.
fn toggle_control(id: ElementId, layout: AnyElement, on_click: Handler, ds: &Ds) -> AnyElement {
    let mut control = Control::new(id, ds);
    control.width = Width::Full;
    control.radius = ds.len(Length::SpaceXs);
    control.fg = Blend::flat(ds.color(Color::TextPrimary));
    control.scale = false;
    control.inline = false;
    control.justify_center = false;
    // `outline-offset: calc(var(--focus-ring-room) - var(--focus-ring-width))`
    control.ring = Ring::Outline(
        f32::from(ds.len(Length::FocusRingRoom)) - f32::from(ds.len(Length::FocusRingWidth)),
    );
    control.text_size = ds.len(Length::TypoBodySize);
    control.line_height = Some(ds.len(Length::TypoBodyLineHeight));
    control.on_click(Some(on_click));
    control.children = vec![layout];
    control.into_any_element()
}

impl RenderOnce for ExpandableText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = cx.background_executor().now();
        let state = window.use_keyed_state((self.id.clone(), "state"), cx, |_, _| State {
            expanded: false,
            clamped: true,
            full: 0.,
            shown: 0.,
            resize: None,
        });
        let line = f32::from(Ds::get(cx).len(Length::TypoBodyLineHeight));
        let collapsed = line * f32::from(self.collapsed_lines);
        let Step {
            height,
            clamped,
            full,
        } = step(&state, now, collapsed, cx);
        let ds = Ds::get(cx);
        let turn_timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
        let resize_timing = if state.read(cx).expanded {
            Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard)
        } else {
            Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate)
        };
        let turn = transition(
            (self.id.clone(), "turn"),
            (f32::from(state.read(cx).expanded), ds.reduced_motion()),
            &turn_timing,
            window,
            cx,
        );
        let overflows = full > collapsed + 1.;
        let ds = Ds::get(cx);
        let mut visible = body_text(self.text.clone(), ds).whitespace_normal();
        if clamped {
            visible = visible
                .line_clamp(usize::from(self.collapsed_lines))
                .text_ellipsis();
        }
        let mut frame = div()
            .id((self.id.clone(), "height"))
            .relative()
            .min_w_0()
            .layout_motion(gpui::LayoutMotion {
                duration_ms: if ds.reduced_motion() {
                    0
                } else {
                    resize_timing.ms()
                },
                easing: resize_timing.easing(),
            });
        if clamped {
            frame = frame.overflow_hidden();
        }
        if let Some(height) = height {
            frame = frame.h(px(height));
        }
        let frame = frame
            .child(visible)
            .child(measuring_copy(self.text.clone(), &state, ds));
        let layout = stack(self.meta, frame, (turn, turn_timing), overflows, ds);
        if !overflows {
            return div()
                .min_w_0()
                .text_color(ds.color(Color::TextPrimary))
                .child(layout)
                .into_any_element();
        }
        toggle_control(
            self.id,
            layout,
            toggle(state, collapsed, ds.reduced_motion()),
            ds,
        )
    }
}
