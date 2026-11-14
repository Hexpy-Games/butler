//! The geometry and lines of a DisclosureRow (`.trigger`, `.titleLine`, `.turn`, `.dot`).
use gpui::{
    App, Div, ElementId, ParentElement as _, Pixels, SharedString, Styled as _, Window, div, px,
    relative,
};

use super::{Affordance, Attention, DisclosureRow, Surface};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::motion::{Props, Timing, Transition, transition};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

/// `--clickable-padding-inline`, the inline padding of a plain row's bleeding trigger.
const CLICKABLE_PADDING: f32 = 10.; // DS: Clickable.module.css:2
/// The dot of a problem row.
const DOT: f32 = 6.; // DS: DisclosureRow.module.css:208

/// The row's inset and padding for its surface and kind (`--disclosure-*`).
pub(super) struct Layout {
    /// `--disclosure-inset`: the trigger's block padding and the panel's insets.
    pub(super) inset: Pixels,
    /// `--disclosure-pad-inline`.
    pub(super) pad: Pixels,
    /// `--disclosure-indent`: 16px per level.
    pub(super) indent: Pixels,
    /// One title line (`--disclosure-line`).
    pub(super) line: Pixels,
    pub(super) block: Pixels,
    pub(super) min_height: Pixels,
    pub(super) interactive: bool,
    has_icon: bool,
    gap: Pixels,
}

impl Layout {
    pub(super) fn new(row: &DisclosureRow, interactive: bool, ds: &Ds) -> Self {
        let plain = row.surface == Surface::Plain;
        let inset = if plain {
            px(0.)
        } else {
            ds.len(Length::SpaceSm)
        };
        let pad = match (plain, interactive) {
            (false, _) => inset,
            (true, true) => px(CLICKABLE_PADDING),
            (true, false) => px(0.),
        };
        let level = row.indent.as_ref().map_or(0, |(level, _)| *level);
        Self {
            inset,
            pad,
            #[expect(clippy::cast_precision_loss, reason = "a few indent levels")]
            indent: ds.len(Length::SpaceLg) * level as f32,
            line: ds.len(Length::TypoBodyLineHeight),
            block: inset,
            min_height: ds.len(Length::ControlHeightMd),
            interactive,
            has_icon: row.icon.is_some(),
            gap: ds.len(Length::SpaceSm),
        }
    }

    /// The panel's start padding: under the title, after the icon.
    pub(super) fn panel_inset(&self) -> Pixels {
        let icon = if self.has_icon {
            self.line + self.gap
        } else {
            px(0.)
        };
        self.inset + self.indent + icon
    }
}

/// How far the chevron has turned (0 closed, 1 open): `--motion-fast` standard.
pub(super) fn chevron_turn(
    id: &ElementId,
    open: bool,
    window: &mut Window,
    cx: &mut App,
) -> (Transition, Timing) {
    let (timing, jump) = {
        let ds = Ds::get(cx);
        (
            Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard),
            ds.reduced_motion(),
        )
    };
    let value = transition(
        (id.clone(), "turn"),
        (f32::from(u8::from(open)), jump),
        &timing,
        window,
        cx,
    );
    (value, timing)
}

/// `.titleLine`: a problem dot, the title, a muted count, then the chevron.
fn title_line(
    row: &mut DisclosureRow,
    layout: &Layout,
    turn: (Transition, Timing),
    ds: &Ds,
) -> Div {
    let dot = row.attention.map(|attention| {
        let color = match attention {
            Attention::Error => Color::TraceError,
            Attention::Warning => Color::TraceWait,
        };
        div()
            .flex_none()
            .self_center()
            .size(px(DOT))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(color))
    });
    let title = div().flex_shrink(1.).min_w_0().child(
        Typo::body(row.title.clone())
            .truncate()
            .tone(Tone::Primary)
            .weight(Weight::Regular),
    );
    let count = row.count.map(|count| {
        div().flex_none().child(
            Typo::caption(SharedString::from(format!("({count})")))
                .tone(Tone::Tertiary)
                .tabular(),
        )
    });
    let chevron = (row.affordance == Affordance::Trailing && layout.interactive).then(|| {
        div()
            .flex()
            .flex_none()
            .self_stretch()
            .items_center()
            .justify_center()
            .text_color(ds.color(Color::TextTertiary))
            .child(turn.0.apply(
                div().child(icon(Icon::ChevronRight, IconSize::Sm, ds)),
                &turn.1,
                &Props {
                    rotation: Some((0., std::f32::consts::FRAC_PI_2)),
                    ..Default::default()
                },
            ))
    });
    div()
        .flex()
        .items_baseline()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .children(dot)
        .child(title)
        .children(count)
        .children(chevron)
}

/// The trigger's content: the first line, the description and the bar.
pub(super) fn line(
    row: &mut DisclosureRow,
    layout: &Layout,
    turn: (Transition, Timing),
    ds: &Ds,
) -> Div {
    let icon = row.icon.take().map(|icon| {
        div()
            .flex()
            .flex_none()
            .self_start()
            .items_center()
            .justify_center()
            .size(layout.line)
            .text_color(ds.color(Color::TextTertiary))
            .child(icon)
    });
    let title = title_line(row, layout, turn, ds);
    let meta = row
        .meta
        .take()
        .map(|meta| div().flex_none().min_w_0().max_w(relative(0.5)).child(meta));
    let first = div()
        .flex()
        .items_baseline()
        .gap(ds.len(Length::SpaceSm))
        .children(icon)
        .child(div().flex_1().min_w_0().child(title))
        .children(meta);
    let cue = row.indent.as_ref().and_then(|(_, cue)| cue.clone());
    let description = match (row.description.take(), cue) {
        (Some(text), Some(cue)) => Some(SharedString::from(format!("{text} · {cue}"))),
        (Some(text), None) => Some(text),
        (None, cue) => cue,
    };
    let inset = if layout.has_icon {
        layout.line + layout.gap
    } else {
        px(0.)
    };
    let description = description.map(|text| {
        div().pl(inset).child(
            Typo::caption(text)
                .tone(Tone::Tertiary)
                .wrap(Wrap::Anywhere),
        )
    });
    let bar = row
        .bar
        .take()
        .map(|bar| div().ml(-layout.indent).child(bar));
    div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .child(first)
        .children(description)
        .children(bar)
}
