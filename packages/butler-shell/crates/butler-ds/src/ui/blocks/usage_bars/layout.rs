//! usageBarsLayout.ts: the geometry of the columns: heights as a share of the plot, the
//! tiny-part merge, the axis label anchors and the loading placeholder.
use super::{Bucket, Series, SeriesColor, Size};

/// One drawn segment of a column.
#[derive(Clone, Debug)]
pub(super) struct ColumnSegment {
    pub color: SeriesColor,
    /// Part of the column total (0 to 1).
    pub share: f64,
    /// The hatched (subtask) part (0 to 1) after the tiny-part merge.
    pub subtask: f64,
}

#[derive(Clone, Debug)]
pub(super) struct Column {
    pub total: f64,
    /// Height as a share of the plot's drawing height (0 to 1).
    pub fraction: f64,
    pub segments: Vec<ColumnSegment>,
}

pub(super) struct Geometry {
    pub columns: Vec<Column>,
    pub slots: usize,
    /// The value of the plot top.
    pub top: f64,
    /// Gridline values (half and top) with y ticks.
    pub ticks: Vec<f64>,
    /// No bucket has a positive total.
    pub blank: bool,
}

/// A round ceiling (1, 2, 4, 5, 8 or 10 times a power of ten) so half and top ticks read cleanly.
pub(super) fn nice_ceiling(value: f64) -> f64 {
    if value <= 0. || !value.is_finite() {
        return 1.;
    }
    let magnitude = 10f64.powf(value.log10().floor());
    let fraction = value / magnitude;
    let step = [1., 2., 4., 5., 8.]
        .into_iter()
        .find(|candidate| fraction <= *candidate)
        .unwrap_or(10.);
    step * magnitude
}

/// Drawing heights (px) of the plot per size: popover 56, panel `--chart-height-panel` (13rem).
pub(super) fn draw_height(size: Size) -> f32 {
    match size {
        Size::Popover => 56.,
        Size::Panel => 208.,
    }
}

/// `--space-sm` of headroom above the tallest column with y ticks.
pub(super) const TICK_HEADROOM: f32 = 8.;
/// Columns and parts are never drawn thinner than this (px).
const MIN_PART_PX: f64 = 2.;

fn positive(value: f64) -> f64 {
    if value.is_finite() && value > 0. {
        value
    } else {
        0.
    }
}

fn column_segments(bucket: &Bucket, series: &[Series]) -> Vec<ColumnSegment> {
    series
        .iter()
        .filter_map(|entry| {
            let matching: Vec<_> = bucket
                .segments
                .iter()
                .filter(|segment| segment.id == entry.id)
                .collect();
            let value: f64 = matching.iter().map(|segment| positive(segment.value)).sum();
            let subtask: f64 = matching
                .iter()
                .map(|segment| positive(segment.subtask))
                .sum::<f64>()
                .min(value);
            (value > 0.).then(|| ColumnSegment {
                color: entry.color,
                share: value,
                subtask: subtask / value,
            })
        })
        .collect()
}

/// Tiny-part merge: when either part of a split segment would be under 2px, the segment is
/// drawn whole in the style of its larger part (solid on a tie).
pub(super) fn merge_tiny_part(subtask: f64, segment_px: f64) -> f64 {
    if subtask <= 0. || subtask >= 1. {
        return subtask;
    }
    let hatched = segment_px * subtask;
    let solid = segment_px - hatched;
    if hatched >= MIN_PART_PX && solid >= MIN_PART_PX {
        subtask
    } else if hatched > solid {
        1.
    } else {
        0.
    }
}

pub(super) fn geometry(
    buckets: &[Bucket],
    series: &[Series],
    min_slots: usize,
    ticks: bool,
    size: Size,
) -> Geometry {
    let stacked: Vec<(f64, Vec<ColumnSegment>)> = buckets
        .iter()
        .map(|bucket| {
            let parts = column_segments(bucket, series);
            let total = parts.iter().map(|segment| segment.share).sum::<f64>();
            let parts = parts
                .into_iter()
                .map(|segment| ColumnSegment {
                    share: segment.share / total,
                    ..segment
                })
                .collect();
            (total, parts)
        })
        .collect();
    let max = stacked.iter().map(|(total, _)| *total).fold(0., f64::max);
    let top = if ticks {
        nice_ceiling(max)
    } else if max > 0. {
        max
    } else {
        1.
    };
    let height = f64::from(draw_height(size) - if ticks { TICK_HEADROOM } else { 0. });
    let columns = stacked
        .into_iter()
        .map(|(total, segments)| {
            let fraction = total / top;
            let column_px = (fraction * height).max(MIN_PART_PX);
            let segments = segments
                .into_iter()
                .map(|segment| ColumnSegment {
                    subtask: merge_tiny_part(segment.subtask, column_px * segment.share),
                    ..segment
                })
                .collect();
            Column {
                total,
                fraction,
                segments,
            }
        })
        .collect();
    Geometry {
        columns,
        slots: buckets.len().max(min_slots).max(1),
        top,
        ticks: if ticks && max > 0. {
            vec![top / 2., top]
        } else {
            Vec::new()
        },
        blank: max <= 0.,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Anchor {
    Start,
    Center,
    End,
}

pub(super) struct Placement {
    pub text: String,
    /// The anchor as a share of the plot width.
    pub left: f32,
    pub anchor: Anchor,
}

/// Labels near an edge anchor to that edge so they never spill past the plot.
pub(super) fn place_axis_labels(
    labels: &[(usize, &str)],
    slots: usize,
    size: Size,
) -> Vec<Placement> {
    let edge = if size == Size::Panel { 0.06 } else { 0.12 };
    labels
        .iter()
        .filter(|(index, _)| *index < slots)
        .map(|(index, text)| {
            let start = *index as f32 / slots as f32;
            let end = (*index + 1) as f32 / slots as f32;
            let (left, anchor) = if start < edge {
                (start, Anchor::Start)
            } else if end > 1. - edge {
                (end, Anchor::End)
            } else {
                (f32::midpoint(start, end), Anchor::Center)
            };
            Placement {
                text: (*text).to_owned(),
                left,
                anchor,
            }
        })
        .collect()
}

const SKELETON_SHAPE: [f32; 10] = [0.3, 0.52, 0.7, 0.18, 0.44, 0.86, 0.6, 0.24, 0.4, 0.18];

/// Placeholder column heights (a share of the plot) for the loading state.
pub(super) fn skeleton_heights(slots: usize) -> Vec<f32> {
    (0..slots)
        .map(|index| SKELETON_SHAPE[index % SKELETON_SHAPE.len()])
        .collect()
}

/// The bucket index under a pointer x, or none over an empty slot or outside the plot.
pub(super) fn bucket_at(
    x: f32,
    left: f32,
    width: f32,
    slots: usize,
    count: usize,
) -> Option<usize> {
    if width <= 0. || count == 0 {
        return None;
    }
    let index = (((x - left) / width) * slots as f32).floor();
    if index < 0. {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "index is a floored, non-negative slot position well below usize::MAX"
    )]
    let index = index as usize;
    (index < count).then_some(index)
}

/// A DS share (0 to 1 or a pixel scale) narrowed to the `f32` the renderer draws with.
#[expect(
    clippy::cast_possible_truncation,
    reason = "DS shares and fractions are small ratios; f32 precision is ample for pixels"
)]
pub(super) fn narrow(value: f64) -> f32 {
    value as f32
}
