//! UsageBarsParts.tsx: the columns with their segments, the gridlines, the y axis, the x axis
//! with its label fit, the note and the loading placeholder.
use gpui::{
    AnyElement, Hsla, IntoElement as _, ParentElement as _, Pixels, Styled as _, Window, div,
    pattern_slash, px, relative,
};

use super::layout::{Anchor, Column, Placement, TICK_HEADROOM, skeleton_heights};
use super::{Emphasis, Size};
use crate::tokens::{Color, Length, Percent};
use crate::ui::context::Ds;
use crate::ui::convert;

/// `--usage-bars-dim`.
const DIM: f32 = 0.4;
/// `--usage-bars-hatch-lift`: the hatch's light stripes under a linked subtask row.
const HATCH_LIFT: f32 = 0.5;

/// The largest column width (px) per size.
fn column_max(size: Size) -> f32 {
    match size {
        Size::Popover => 14.,
        Size::Panel => 24.,
    }
}

/// The radius of a column's top corners (`calc(2px / var(--ui-scale))`, 4px for the panel).
fn top_radius(size: Size) -> Pixels {
    px(match size {
        Size::Popover => 2.,
        Size::Panel => 4.,
    })
}

/// One drawn segment: solid, or hatched with the subtask part.
fn paint_segment(color: Hsla, hatched: bool, emphasis: Option<Emphasis>, ds: &Ds) -> gpui::Div {
    let base = div();
    if !hatched {
        return base.bg(color);
    }
    // `repeating-linear-gradient(135deg, c 0 2px, c@hatch-alpha 2px 4px)`
    let alpha = ds.tokens().percent(Percent::HatchAlpha);
    let alpha = if emphasis == Some(Emphasis::Subtask) {
        alpha + (1. - alpha) * HATCH_LIFT
    } else {
        alpha
    };
    let el = base
        .bg(convert::with_alpha(color, alpha))
        .child(div().size_full().bg(pattern_slash(color, 2., 4.)));
    if emphasis == Some(Emphasis::Conversation) {
        el.opacity(DIM)
    } else {
        el
    }
}

/// One stacked column in its slot; its segments share its height by value, with no gaps.
pub(super) fn column(
    column: &Column,
    height: f32,
    selected: bool,
    dimmed: bool,
    (size, emphasis): (Size, Option<Emphasis>),
    ds: &Ds,
) -> AnyElement {
    let mut stack = div().flex().flex_col_reverse().w_full();
    let mut stack_h = 0.;
    let count = column.segments.len();
    for (index, segment) in column.segments.iter().enumerate() {
        let color = ds.color(segment.color.token());
        let px_h = if index + 1 == count {
            height - stack_h
        } else {
            height * segment.share as f32
        };
        stack_h += px_h;
        let hatched = |part: gpui::Div, whole: f32| part.h(px(px_h * whole));
        let cell = if segment.subtask <= 0. {
            hatched(paint_segment(color, false, emphasis, ds), 1.)
        } else if segment.subtask >= 1. {
            hatched(paint_segment(color, true, emphasis, ds), 1.)
        } else {
            let sub = segment.subtask as f32;
            div()
                .flex()
                .flex_col_reverse()
                .h(px(px_h))
                .child(hatched(paint_segment(color, false, emphasis, ds), 1. - sub))
                .child(hatched(paint_segment(color, true, emphasis, ds), sub))
        };
        stack = stack.child(cell);
    }
    let mut col = div()
        .w_full()
        .max_w(px(column_max(size)))
        .h(px(if column.total > 0. { height } else { 0. }))
        .overflow_hidden()
        .rounded_t(top_radius(size))
        .child(stack);
    if dimmed && !selected {
        col = col.opacity(DIM);
    }
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .items_end()
        .justify_center()
        .px(px(1.))
        .child(col)
        .into_any_element()
}

/// A gridline at `fraction` of the drawing height above the baseline.
pub(super) fn gridline(fraction: f32, plot_h: f32, headroom: f32, ds: &Ds) -> AnyElement {
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom(px(fraction * (plot_h - headroom)))
        .h(px(1.))
        .bg(ds.color(Color::Line))
        .opacity(0.7)
        .into_any_element()
}

/// The left gutter: 0, half and top values, as wide as the widest label.
pub(super) fn y_axis(labels: &[(f32, String)], width: f32, plot_h: f32, ds: &Ds) -> AnyElement {
    let line = ds.len(Length::TypoCaptionLineHeightTight);
    let mut axis = div()
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(plot_h))
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(line)
        .text_right();
    for (fraction, text) in labels {
        let top = plot_h - fraction * (plot_h - TICK_HEADROOM);
        axis = axis.child(
            div()
                .absolute()
                .right_0()
                .top(px(top) - line / 2.)
                .whitespace_nowrap()
                .child(text.clone()),
        );
    }
    axis.into_any_element()
}

/// How an axis label is shown: kept or hidden, and how far it shifts back into the axis.
pub(super) struct Fit {
    pub hidden: bool,
    pub nudge: f32,
}

/// `fitLabels`: labels stay inside the axis (one that would spill past an edge shifts back in),
/// then labels that would touch a kept neighbour are hidden; the last label always stays.
pub(super) fn fit(placements: &[Placement], widths: &[f32], axis: f32, gap: f32) -> Vec<Fit> {
    let boxes: Vec<(f32, f32, f32)> = placements
        .iter()
        .zip(widths)
        .map(|(placed, width)| {
            let at = placed.left * axis;
            let left = match placed.anchor {
                Anchor::Start => at,
                Anchor::Center => at - width / 2.,
                Anchor::End => at - width,
            };
            let nudge = (-left).max(0.) + (axis - (left + width)).min(0.);
            (left + nudge, left + nudge + width, nudge)
        })
        .collect();
    let Some(last) = boxes.last().copied() else {
        return Vec::new();
    };
    let mut kept_right = f32::NEG_INFINITY;
    let count = boxes.len();
    boxes
        .iter()
        .enumerate()
        .map(|(index, (left, right, nudge))| {
            if index + 1 == count || count < 2 {
                return Fit {
                    hidden: false,
                    nudge: *nudge,
                };
            }
            if *left < kept_right + gap || right + gap > last.0 {
                Fit {
                    hidden: true,
                    nudge: *nudge,
                }
            } else {
                kept_right = *right;
                Fit {
                    hidden: false,
                    nudge: *nudge,
                }
            }
        })
        .collect()
}

/// The x axis: one caption line with the labels anchored along it.
pub(super) fn x_axis(placements: &[Placement], fits: &[Fit], axis_w: f32, ds: &Ds) -> AnyElement {
    let mut axis = div()
        .relative()
        .min_w_0()
        .h(ds.len(Length::TypoCaptionLineHeight))
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(ds.len(Length::TypoCaptionLineHeight));
    for (placed, fit) in placements.iter().zip(fits) {
        if fit.hidden {
            continue;
        }
        let at = placed.left * axis_w + fit.nudge;
        // A zero-width box at the anchor: the label overflows it to the side the anchor names.
        let holder = div().absolute().top_0().left(px(at)).w_0().flex();
        let holder = match placed.anchor {
            Anchor::Start => holder.justify_start(),
            Anchor::Center => holder.justify_center(),
            Anchor::End => holder.justify_end(),
        };
        axis = axis.child(
            holder.child(
                div()
                    .flex_none()
                    .whitespace_nowrap()
                    .child(placed.text.clone()),
            ),
        );
    }
    axis.into_any_element()
}

/// The note after the last bar.
pub(super) fn note(text: gpui::SharedString, count: usize, slots: usize, ds: &Ds) -> AnyElement {
    div()
        .absolute()
        .bottom(px(6.)) // DS: UsageBars.module.css:271
        .left(relative(count as f32 / slots as f32))
        .ml(ds.len(Length::SpaceSm))
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .whitespace_nowrap()
        .child(text)
        .into_any_element()
}

/// The empty plot's centred line.
pub(super) fn empty(text: gpui::SharedString, size: Size, ds: &Ds) -> AnyElement {
    let (font, line) = match size {
        Size::Popover => (Length::TypoCaptionSize, Length::TypoCaptionLineHeight),
        Size::Panel => (Length::TypoLabelSize, Length::TypoLabelLineHeight),
    };
    div()
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .bottom(px(1.))
        .flex()
        .items_center()
        .justify_center()
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(font))
        .line_height(ds.len(line))
        .child(text)
        .into_any_element()
}

/// Placeholder columns for the loading state.
pub(super) fn skeleton(
    slots: usize,
    plot_h: f32,
    size: Size,
    ds: &Ds,
    _: &mut Window,
) -> Vec<AnyElement> {
    let fill = convert::mix(ds.color(Color::SurfaceRaised), ds.color(Color::Line), 0.5);
    skeleton_heights(slots)
        .into_iter()
        .map(|share| {
            div()
                .flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .items_end()
                .justify_center()
                .px(px(1.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(column_max(size)))
                        .h(px(share * plot_h))
                        .rounded_t(top_radius(size))
                        .bg(fill),
                )
                .into_any_element()
        })
        .collect()
}
