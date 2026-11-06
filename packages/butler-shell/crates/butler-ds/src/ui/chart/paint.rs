//! The chart's drawing: recharts' layout of a category chart (plot rectangle, value axis ticks,
//! grid, bars in bands or points joined by a line, tick labels) painted on a canvas.
use gpui::{
    App, Bounds, Corners, Edges, Font, FontWeight, Hsla, PaintQuad, PathBuilder, Pixels, Point,
    SharedString, TextAlign, TextRun, Window, point, px, size,
};

use super::scale;
use super::{Kind, Spec};

/// recharts' default plot padding and axis sizes.
const X_AXIS_HEIGHT: f32 = 30.; // recharts XAxis `height`
const TICK_MARGIN: f32 = 8.; // recharts `tickMargin` default
const TICK_SIZE: f32 = 14.; // the tick labels take the page's body size
const BAR_CATEGORY_GAP: f32 = 0.1; // `barCategoryGap="10%"`
const BAR_GAP: f32 = 4.; // `barGap`
const DOT_RADIUS: f32 = 3.; // recharts Line `dot` r

/// The plot rectangle and the value axis, in chart-local coordinates.
pub(super) struct Plot {
    pub(super) left: f32,
    pub(super) right: f32,
    pub(super) top: f32,
    pub(super) bottom: f32,
    pub(super) ticks: Vec<f64>,
}

impl Plot {
    pub(super) fn new(spec: &Spec, width: f32, height: f32) -> Self {
        let margin = spec.margin;
        let max = spec.max_value();
        Self {
            left: margin.left + spec.y_width,
            right: width - margin.right,
            top: margin.top,
            bottom: height - margin.bottom - X_AXIS_HEIGHT,
            ticks: scale::ticks(max, spec.allow_decimals),
        }
    }

    fn top_value(&self) -> f64 {
        self.ticks
            .last()
            .copied()
            .unwrap_or(1.)
            .max(f64::MIN_POSITIVE)
    }

    pub(super) fn y(&self, value: f64) -> f32 {
        self.bottom - (value / self.top_value()) as f32 * (self.bottom - self.top)
    }

    fn band(&self, count: usize) -> f32 {
        (self.right - self.left) / count.max(1) as f32
    }

    /// Where category `index` sits on the x axis: its band's centre, or its point.
    fn x(&self, kind: Kind, count: usize, index: usize) -> f32 {
        match kind {
            Kind::Bar => self.left + self.band(count) * (index as f32 + 0.5),
            Kind::Line if count > 1 => {
                self.left + (self.right - self.left) * index as f32 / (count - 1) as f32
            }
            Kind::Line => (self.left + self.right) / 2.,
        }
    }

    /// The category under a point of the plot (the tooltip's active index).
    pub(super) fn index_at(&self, spec: &Spec, x: f32, y: f32) -> Option<usize> {
        let count = spec.categories.len();
        let inside = x >= self.left && x <= self.right && y >= self.top && y <= self.bottom;
        if !inside || count == 0 {
            return None;
        }
        let along = x - self.left;
        Some(match spec.kind {
            Kind::Bar => ((along / self.band(count)).floor() as usize).min(count - 1),
            Kind::Line if count > 1 => {
                let step = (self.right - self.left) / (count - 1) as f32;
                (along / step).round() as usize
            }
            Kind::Line => 0,
        })
    }
}

fn rect(origin: Point<Pixels>, x: f32, y: f32, width: f32, height: f32) -> Bounds<Pixels> {
    Bounds::new(
        point(origin.x + px(x), origin.y + px(y)),
        size(px(width), px(height)),
    )
}

/// One line of text whose baseline sits at `baseline`, aligned on `x` (`middle` or `end`).
fn text(
    (window, cx): (&mut Window, &mut App),
    label: &str,
    (family, color): (&SharedString, Hsla),
    (x, baseline): (f32, f32),
    align: TextAlign,
    origin: Point<Pixels>,
) {
    let font = Font {
        weight: FontWeight::NORMAL,
        ..gpui::font(family.clone())
    };
    let size_px = px(TICK_SIZE);
    let run = TextRun {
        len: label.len(),
        font: font.clone(),
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
        letter_spacing: None,
    };
    let line =
        window
            .text_system()
            .shape_line(SharedString::from(label.to_owned()), size_px, &[run]);
    let id = window.text_system().resolve_font(&font);
    let ascent = f32::from(window.text_system().ascent(id, size_px));
    let descent = f32::from(window.text_system().descent(id, size_px));
    let line_height = ascent + descent;
    let width = f32::from(line.width());
    let left = match align {
        TextAlign::Center => x - width / 2.,
        TextAlign::Right | TextAlign::End => x - width,
        _ => x,
    };
    let at = point(origin.x + px(left), origin.y + px(baseline - ascent));
    let _ = line.paint(at, px(line_height), TextAlign::Left, None, window, cx);
}

/// Paints the whole chart into `bounds`; `active` is the category the pointer is over.
pub(super) fn chart(
    (window, cx): (&mut Window, &mut App),
    bounds: Bounds<Pixels>,
    spec: &Spec,
    active: Option<usize>,
) {
    let plot = Plot::new(
        spec,
        f32::from(bounds.size.width),
        f32::from(bounds.size.height),
    );
    let origin = bounds.origin;
    let width = plot.right - plot.left;
    for tick in &plot.ticks {
        let y = plot.y(*tick);
        window.paint_quad(
            PaintQuad::new(rect(origin, plot.left, y - 0.5, width, 1.)).background(spec.grid),
        );
    }
    match spec.kind {
        Kind::Bar => bars(window, origin, &plot, spec),
        Kind::Line => lines(window, origin, &plot, spec),
    }
    if let Some(index) = active {
        cursor(window, origin, &plot, spec, index);
    }
    let count = spec.categories.len();
    for (index, category) in spec.categories.iter().enumerate() {
        let x = plot.x(spec.kind, count, index);
        let baseline = plot.bottom + TICK_MARGIN + 0.71 * TICK_SIZE;
        text(
            (window, cx),
            category,
            (&spec.family, spec.tick),
            (x, baseline),
            TextAlign::Center,
            origin,
        );
    }
    for tick in &plot.ticks {
        let label = format!("{}{}", scale::format(*tick), spec.unit);
        let baseline = plot.y(*tick) + 0.355 * TICK_SIZE;
        text(
            (window, cx),
            &label,
            (&spec.family, spec.tick),
            (plot.left - TICK_MARGIN, baseline),
            TextAlign::Right,
            origin,
        );
    }
}

/// The tooltip cursor: a band over the hovered bars, a vertical line at the hovered point.
fn cursor(window: &mut Window, origin: Point<Pixels>, plot: &Plot, spec: &Spec, index: usize) {
    let count = spec.categories.len();
    let height = plot.bottom - plot.top;
    match spec.kind {
        Kind::Bar => {
            let band = plot.band(count);
            let left = plot.left + band * index as f32;
            window.paint_quad(
                PaintQuad::new(rect(origin, left, plot.top, band, height)).background(spec.cursor),
            );
        }
        Kind::Line => {
            let x = plot.x(spec.kind, count, index);
            window.paint_quad(
                PaintQuad::new(rect(origin, x - 0.5, plot.top, 1., height)).background(spec.cursor),
            );
        }
    }
}

/// Bars in each category's band; a stacked chart is one bar per band, the series on top of
/// each other, otherwise the series sit side by side.
fn bars(window: &mut Window, origin: Point<Pixels>, plot: &Plot, spec: &Spec) {
    let count = spec.categories.len();
    let band = plot.band(count);
    let across = if spec.stacked {
        1
    } else {
        spec.series.len().max(1)
    };
    let room = band * (1. - 2. * BAR_CATEGORY_GAP) - BAR_GAP * (across - 1) as f32;
    let each = (room / across as f32).floor().max(0.);
    for index in 0..count {
        let band_left = plot.left + band * index as f32 + band * BAR_CATEGORY_GAP;
        let mut stacked = 0.;
        for (series_index, series) in spec.series.iter().enumerate() {
            let value = series.values.get(index).copied().unwrap_or(0.);
            let (from, to) = if spec.stacked {
                (stacked, stacked + value)
            } else {
                (0., value)
            };
            stacked += value;
            let slot = if spec.stacked { 0 } else { series_index };
            let x = band_left + slot as f32 * (each + BAR_GAP);
            let (top, bottom) = (plot.y(to), plot.y(from));
            if bottom - top > 0. {
                window.paint_quad(
                    PaintQuad::new(rect(origin, x, top, each, bottom - top))
                        .background(series.color),
                );
            }
        }
    }
}

/// One polyline per series with a ringed dot on every point.
fn lines(window: &mut Window, origin: Point<Pixels>, plot: &Plot, spec: &Spec) {
    let count = spec.categories.len();
    for series in &spec.series {
        let points: Vec<Point<Pixels>> = (0..count)
            .map(|index| {
                let value = series.values.get(index).copied().unwrap_or(0.);
                point(
                    origin.x + px(plot.x(spec.kind, count, index)),
                    origin.y + px(plot.y(value)),
                )
            })
            .collect();
        let mut path = PathBuilder::stroke(px(1.));
        for (index, at) in points.iter().enumerate() {
            if index == 0 {
                path.move_to(*at);
            } else {
                path.line_to(*at);
            }
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, series.color);
        }
        for at in points {
            let dot = Bounds::new(
                point(at.x - px(DOT_RADIUS), at.y - px(DOT_RADIUS)),
                size(px(DOT_RADIUS * 2.), px(DOT_RADIUS * 2.)),
            );
            window.paint_quad(
                PaintQuad::new(dot)
                    .background(spec.dot_fill)
                    .corner_radii(Corners::all(px(DOT_RADIUS)))
                    .border_widths(Edges::all(px(1.)))
                    .border_color(series.color),
            );
        }
    }
}
