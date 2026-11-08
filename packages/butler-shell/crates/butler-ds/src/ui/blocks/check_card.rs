//! DS CheckCard (CheckCard.tsx / CheckIndicator.tsx / CheckCard.module.css): a card that is
//! picked or not. It rides on ChoiceCard's surface (border, radius, padding, hover, press fill,
//! focus ring, selected look) and adds the round check indicator, centred on the card at the end:
//! checked fills the ring with the accent from the centre and draws the check. A blocked card
//! (`disabled`, or a `disabled_reason`) stays focusable so the reason can be read in a tooltip.
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, Bounds, ElementId, Hsla, IntoElement, ParentElement, PathBuilder, Pixels,
    RenderOnce, SharedString, Styled as _, Window, canvas, div, point, px,
};

pub use super::choice_card::ChoiceCardList as CheckCardList;
use super::choice_card::{ChoiceState, Face, row_body, surface, text_column};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};
use crate::ui::context::Ds;
use crate::ui::convert::{easing, mix};
use crate::ui::motion::{Timing, transition};
use crate::ui::overlay::place::{Align, Side};
use crate::ui::tooltip::Tooltip;

/// CheckIcon's geometry (Hugeicons 24 grid), drawn as a stroke so it can draw in.
const CHECK_PATH: [(f32, f32); 3] = [(5., 14.), (8.5, 17.5), (19., 6.5)]; // DS: CheckIndicator.tsx:4
const STROKE: f32 = 2.5; // DS: CheckIndicator.tsx:16
const VIEW: f32 = 24.;

/// How far each part of the indicator has come, 0 to 1.
#[derive(Clone, Copy)]
struct Phase {
    fill: f32,
    mark: f32,
    mark_opacity: f32,
}

/// The indicator at progress `p` (0 unchecked, 1 checked). Checking: the fill grows, and one
/// `--motion-instant` later the check fades in and draws. Unchecking: the check undraws first,
/// then the fill clears. `draws` is false under reduced motion (fades only, no stroke travel).
fn phase(p: f32, checking: bool, draws: bool, ds: &Ds) -> Phase {
    let ms = |token| ds.duration(token).as_secs_f32() * 1000.;
    let (base, instant, fast) = (
        ms(DsDuration::MotionBase),
        ms(DsDuration::MotionInstant),
        ms(DsDuration::MotionFast),
    );
    let (exit_base, exit_fast) = (
        ms(DsDuration::MotionExitBase),
        ms(DsDuration::MotionExitFast),
    );
    let step = |from: f32, length: f32| ((from) / length.max(f32::EPSILON)).clamp(0., 1.);
    let curve = |token| easing(ds.tokens().ease(token));
    let phase = if checking {
        let elapsed = p * total(checking, ds);
        Phase {
            fill: curve(Easing::MotionEaseDecelerate)(step(elapsed, base)),
            mark: curve(Easing::MotionEaseDraw)(step(elapsed - instant, base)),
            mark_opacity: curve(Easing::MotionEaseStandard)(step(elapsed - instant, fast)),
        }
    } else {
        let elapsed = (1. - p) * total(checking, ds);
        let accelerate = curve(Easing::MotionEaseAccelerate);
        let mark = 1. - accelerate(step(elapsed, exit_fast));
        Phase {
            fill: 1. - accelerate(step(elapsed - instant, exit_base)),
            mark,
            mark_opacity: mark,
        }
    };
    Phase {
        mark: if draws { phase.mark } else { 1. },
        ..phase
    }
}

/// The milliseconds a full toggle takes: 220 checking, 170 unchecking.
fn total(checking: bool, ds: &Ds) -> f32 {
    let ms = |token| ds.duration(token).as_secs_f32() * 1000.;
    if checking {
        ms(DsDuration::MotionBase).max(ms(DsDuration::MotionInstant) + ms(DsDuration::MotionBase))
    } else {
        (ms(DsDuration::MotionInstant) + ms(DsDuration::MotionExitBase))
            .max(ms(DsDuration::MotionExitFast))
    }
}

/// The check polyline cut at `fraction` of its length.
fn partial(fraction: f32) -> Vec<(f32, f32)> {
    let length = |a: (f32, f32), b: (f32, f32)| (b.0 - a.0).hypot(b.1 - a.1);
    let all: f32 = CHECK_PATH.windows(2).map(|w| length(w[0], w[1])).sum();
    let mut left = all * fraction.clamp(0., 1.);
    let mut out = vec![CHECK_PATH[0]];
    for w in CHECK_PATH.windows(2) {
        let span = length(w[0], w[1]);
        if left >= span {
            out.push(w[1]);
            left -= span;
        } else {
            let k = left / span;
            out.push((
                w[0].0 + (w[1].0 - w[0].0) * k,
                w[0].1 + (w[1].1 - w[0].1) * k,
            ));
            break;
        }
    }
    out
}

/// A round-capped, round-joined stroke of the check, `fraction` drawn.
fn paint_check(bounds: Bounds<Pixels>, fraction: f32, color: Hsla, window: &mut Window) {
    let unit = f32::from(bounds.size.width) / VIEW;
    let at = |(x, y): (f32, f32)| {
        point(
            bounds.origin.x + px(x * unit),
            bounds.origin.y + px(y * unit),
        )
    };
    let points = partial(fraction);
    let width = STROKE * unit;
    if points.len() >= 2 {
        let mut path = PathBuilder::stroke(px(width));
        path.move_to(at(points[0]));
        for p in &points[1..] {
            path.line_to(at(*p));
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, color);
        }
    }
    for p in &points {
        let c = at(*p);
        let mut disc = PathBuilder::fill();
        for i in 0..16 {
            let a = i as f32 / 16. * std::f32::consts::TAU;
            let v = point(
                c.x + px(width / 2. * a.cos()),
                c.y + px(width / 2. * a.sin()),
            );
            if i == 0 {
                disc.move_to(v);
            } else {
                disc.line_to(v);
            }
        }
        disc.close();
        if let Ok(disc) = disc.build() {
            window.paint_path(disc, color);
        }
    }
}

/// The round check indicator: a ring on the card surface. Both the fill and the check stay
/// mounted so a toggle mid-animation reverses from where it is.
fn indicator(id: ElementId, checked: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let timing = Timing::linear(Duration::from_secs_f32(total(checked, ds) / 1000.));
    let progress = transition(
        id,
        (f32::from(u8::from(checked)), false),
        &timing,
        window,
        cx,
    );
    let moving = progress.moving(&timing);
    if moving {
        let elapsed = Duration::from_millis(u64::from(
            gpui::animation_time_ms().wrapping_sub(progress.start_ms),
        ));
        crate::ui::motion::wake_after(window, cx, timing.duration.saturating_sub(elapsed));
    }
    let ds = Ds::get(cx);
    let side = ds.len(Length::IconSizeMd);
    let n = timing.ms().saturating_mul(60).div_ceil(1000);
    let frames = (0..if moving { n } else { 1 }).map(|i| {
        let p = if moving {
            progress.from + (progress.to - progress.from) * (i + 1) as f32 / n as f32
        } else {
            progress.to
        };
        let phase = phase(p, checked, !ds.reduced_motion(), ds);
        let hairline = ds.len(Length::BorderHairline);
        let accent = ds.color(Color::Accent);
        let mut ink = ds.color(Color::PrimaryForeground);
        ink.alpha *= phase.mark_opacity;
        let scale = ds.number(Number::MotionScaleCheck);
        let ring = mix(accent, ds.color(Color::LineStrong), phase.fill);
        let fill = div()
            .absolute()
            .top(-hairline)
            .bottom(-hairline)
            .left(-hairline)
            .right(-hairline)
            .rounded(ds.len(Length::RadiusPill))
            .bg(accent)
            .opacity(phase.fill)
            .scale(scale + (1. - scale) * phase.fill);
        let mark = canvas(
            |_, _, _| (),
            move |bounds, (), window, _| paint_check(bounds, phase.mark, ink, window),
        )
        .size(ds.len(Length::IconSizeXs));
        let frame = div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(side)
            .border(hairline)
            .border_color(ring)
            .rounded(ds.len(Length::RadiusPill))
            .child(fill)
            .child(div().relative().child(mark));
        let layer = div().absolute().size_full().child(frame);
        if moving {
            layer.motion(gpui::LayerMotion {
                visible: (i as f32 / n as f32, (i + 1) as f32 / n as f32),
                ..timing.motion(progress.start_ms)
            })
        } else {
            layer
        }
    });
    div()
        .relative()
        .flex_none()
        .size(side)
        .children(frames)
        .into_any_element()
}

type Toggle = Rc<dyn Fn(bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct CheckCard {
    id: ElementId,
    icon: Option<AnyElement>,
    title: SharedString,
    description: Option<SharedString>,
    checked: bool,
    on_checked_change: Toggle,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    reason_side: Side,
    reason_align: Align,
}

impl CheckCard {
    pub fn new(
        id: impl Into<ElementId>,
        title: impl Into<SharedString>,
        checked: bool,
        on_checked_change: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            icon: None,
            title: title.into(),
            description: None,
            checked,
            on_checked_change: Rc::new(on_checked_change),
            disabled: false,
            disabled_reason: None,
            reason_side: Side::Top,
            reason_align: Align::Center,
        }
    }

    /// Optional leading glyph (a logo or `choice_card::glyph`), bare on the title line.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Cannot be picked right now (busy): dimmed, clicks ignored.
    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Cannot be picked, with the reason in a tooltip; the card stays focusable.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    /// Side the reason tooltip opens on (default `Top`, above the card).
    pub fn disabled_reason_side(mut self, side: Side) -> Self {
        self.reason_side = side;
        self
    }

    /// Alignment of the reason tooltip along that side (default `Center`).
    pub fn disabled_reason_align(mut self, align: Align) -> Self {
        self.reason_align = align;
        self
    }
}

impl RenderOnce for CheckCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let blocked = self.disabled || self.disabled_reason.is_some();
        let face = Face {
            selected: self.checked,
            state: if blocked {
                ChoiceState::Disabled
            } else {
                ChoiceState::Default
            },
            placeholder: false,
            fade: DsDuration::MotionBase, // DS: CheckCard.module.css:7
            padding: Length::SpaceMd,
            min_height: Some(64.), // DS: ChoiceCard.module.css:113
        };
        let end = indicator((self.id.clone(), "check").into(), self.checked, window, cx);
        let ds = Ds::get(cx);
        let text = text_column(self.title, None, self.description, false, ds);
        let body = row_body(self.icon, text, Some(end), ds);
        let (checked, change) = (self.checked, self.on_checked_change);
        let card = surface(
            self.id.clone(),
            &face,
            body,
            Some(Rc::new(move |_, window, cx| change(!checked, window, cx))),
            window,
            cx,
        );
        match self.disabled_reason {
            Some(reason) => Tooltip::new((self.id, "reason"))
                .label(reason)
                .side(self.reason_side)
                .align(self.reason_align)
                .fill()
                .child(card)
                .into_any_element(),
            None => card.into_any_element(),
        }
    }
}
