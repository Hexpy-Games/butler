//! `spanGeometry.ts`: where a span sits on a trace's axis, how it splits over its children,
//! and which ticks the axis labels. Times are in one unit (ms from the trace start).

/// Fractions (0 to 1) of the trace a span covers, clamped to the trace.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Fraction {
    pub(super) start: f64,
    pub(super) width: f64,
}

/// Clamps a span to `[0, total]`; a zero, negative or non-finite total yields an empty span, and
/// a non-finite offset or duration counts as 0 (`spanFraction`).
pub(super) fn span_fraction(offset: f64, duration: f64, total: f64) -> Fraction {
    if !valid_total(total) {
        return Fraction {
            start: 0.,
            width: 0.,
        };
    }
    let from = finite_or_0(offset);
    let start = from.clamp(0., total);
    let end = (from + finite_or_0(duration).max(0.)).clamp(start, total);
    Fraction {
        start: start / total,
        width: (end - start) / total,
    }
}

/// One painted piece of a span, as fractions (0 to 1) of the span itself (`SpanPiece`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Piece<T> {
    pub(super) start: f64,
    pub(super) width: f64,
    pub(super) tone: T,
    /// Every other drawn child is hatched, so adjacent children stay apart without gaps.
    pub(super) hatch: bool,
}

/// A direct child of a span: `(offset, duration, tone)` in the span's unit.
pub(super) type Child<T> = (f64, f64, T);

/// Splits a span into one piece per direct child (time order, clipped to the span, overlaps cut
/// at the earlier child's end) and fills the span's uncovered time with pieces in its own tone.
/// No pieces when the span is empty or no child lands inside it: the caller draws a plain bar
/// (`spanPieces`).
pub(super) fn span_pieces<T: Copy>(
    offset: f64,
    duration: f64,
    tone: T,
    segments: &[Child<T>],
) -> Vec<Piece<T>> {
    let from = finite_or_0(offset);
    let end = from
        + if duration.is_finite() {
            duration.max(0.)
        } else {
            0.
        };
    if end <= from {
        return Vec::new();
    }
    let length = end - from;
    let piece = |start: f64, stop: f64, tone: T, hatch: bool| Piece {
        start: (start - from) / length,
        width: (stop - start) / length,
        tone,
        hatch,
    };
    let mut children: Vec<&Child<T>> = segments
        .iter()
        .filter(|(offset, duration, _)| {
            offset.is_finite() && duration.is_finite() && *duration > 0.
        })
        .collect();
    children.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut pieces = Vec::new();
    let (mut cursor, mut drawn) = (from, 0_usize);
    for (child_offset, child_duration, child_tone) in children {
        let start = child_offset.max(cursor);
        let stop = (child_offset + child_duration).min(end);
        if stop <= start {
            continue;
        }
        if start > cursor {
            pieces.push(piece(cursor, start, tone, false));
        }
        pieces.push(piece(start, stop, *child_tone, drawn % 2 == 1));
        drawn += 1;
        cursor = stop;
    }
    if drawn == 0 {
        return Vec::new();
    }
    if end > cursor {
        pieces.push(piece(cursor, end, tone, false));
    }
    pieces
}

/// The smallest 1, 2, 5 x 10^n step that splits `total` into at most `intervals` parts
/// (`spanTickStep`).
fn tick_step(total: f64, intervals: f64) -> f64 {
    if !valid_total(total) {
        return 0.;
    }
    let raw = total / intervals;
    let magnitude = 10_f64.powf(raw.log10().floor());
    [1., 2., 5., 10.]
        .iter()
        .map(|factor| factor * magnitude)
        .find(|candidate| *candidate >= raw)
        .unwrap_or(10. * magnitude)
}

/// The least distance between two tick labels as a fraction of the axis (`spanTicks` `gap`).
pub(super) const DEFAULT_GAP: f64 = 0.12;

/// Axis ticks: 0, the given (or 1, 2, 5) interior ticks, and the total. An interior tick closer
/// than `gap` (a fraction of the axis) to its neighbour or to the total is dropped, so labels
/// never collide on a narrow axis (`spanTicks`).
pub(super) fn span_ticks(total: f64, ticks: Option<&[f64]>, gap: f64) -> Vec<f64> {
    if !valid_total(total) {
        return vec![0.];
    }
    let step = tick_step(total, (1. / gap).floor().clamp(1., 6.));
    let interior: Vec<f64> = match ticks {
        Some(ticks) => {
            let mut inside: Vec<f64> = ticks
                .iter()
                .copied()
                .filter(|tick| *tick > 0. && *tick < total)
                .collect();
            inside.sort_by(f64::total_cmp);
            inside.dedup();
            inside
        }
        None => {
            let (mut index, mut all) = (1_f64, Vec::new());
            while index * step < total {
                all.push(index * step);
                index += 1.;
            }
            all
        }
    };
    let mut kept = vec![0.];
    for tick in interior {
        let last = kept.last().copied().unwrap_or(0.);
        if (tick - last) / total >= gap && (total - tick) / total >= gap {
            kept.push(tick);
        }
    }
    kept.push(total);
    kept
}

/// Default label: milliseconds under a second, else seconds with up to two decimals
/// (`formatSpanMs`).
pub fn format_span_ms(ms: f64) -> String {
    if ms == 0. {
        return "0s".to_owned();
    }
    if ms < 1000. {
        return format!("{}ms", ms.round());
    }
    let seconds: f64 = format!("{:.2}", ms / 1000.).parse().unwrap_or_default();
    format!("{seconds}s")
}

/// A 0 to 1 fraction as the layout's `f32`.
#[expect(clippy::cast_possible_truncation, reason = "a fraction of a width")]
pub(super) fn narrow(value: f64) -> f32 {
    value as f32
}

fn valid_total(total: f64) -> bool {
    total.is_finite() && total > 0.
}

fn finite_or_0(value: f64) -> f64 {
    if value.is_finite() { value } else { 0. }
}
