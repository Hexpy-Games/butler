//! DS Chart (components/Chart, shadcn/ui/chart.tsx): the bar and line charts of the answer
//! blocks, painted natively with recharts' layout rules instead of recharts. A category axis
//! under a value axis from zero with recharts' tick choice, a horizontal grid, bars (grouped or
//! stacked) or lines with dots, the `CHART_COLORS` series colours and a tooltip that follows the
//! pointer over the hovered category. Other chart types are not implemented.
mod legend;
mod paint;
mod scale;
mod tooltip;

use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, Hsla, InteractiveElement as _, IntoElement, MouseMoveEvent,
    ParentElement, Pixels, Point, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, canvas, div, px,
};

pub use self::legend::{ChartColor, ChartLegend, LegendItem, LegendSwatch, SwatchShape};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bar,
    Line,
}

/// `panel`: a full-width 13rem chart for dashboard panels. The default is 150px tall, at least
/// 220px wide.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Default,
    Panel,
}

/// What the tooltip's title says: the hovered category, or (as the answer chart's tooltip does)
/// the label of the first series.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TooltipTitle {
    #[default]
    Category,
    FirstSeries,
}

/// The chart's inset inside its box (`margin`).
#[derive(Clone, Copy, Debug)]
pub struct Margin {
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
}

impl Margin {
    /// recharts' default of 5px on every side.
    pub const DEFAULT: Self = Self::all(5.);

    pub const fn all(side: f32) -> Self {
        Self {
            left: side,
            right: side,
            top: side,
            bottom: side,
        }
    }
}

/// One series: its name, colour and a value per category.
pub struct Series {
    pub name: SharedString,
    pub color: ChartColor,
    pub values: Vec<f64>,
}

/// A series with its colour resolved.
pub(crate) struct DrawnSeries {
    pub(crate) name: SharedString,
    pub(crate) color: Hsla,
    pub(crate) values: Vec<f64>,
}

/// Everything the painter and the tooltip need, resolved against the theme.
pub(crate) struct Spec {
    pub(crate) kind: Kind,
    pub(crate) categories: Vec<SharedString>,
    pub(crate) series: Vec<DrawnSeries>,
    pub(crate) stacked: bool,
    pub(crate) unit: SharedString,
    pub(crate) margin: Margin,
    pub(crate) y_width: f32,
    pub(crate) allow_decimals: bool,
    pub(crate) title: TooltipTitle,
    pub(crate) family: SharedString,
    pub(crate) grid: Hsla,
    /// recharts' tick fill (`#666`), the cursor (`#ccc`, half opaque) and the dot's fill.
    pub(crate) tick: Hsla,
    pub(crate) cursor: Hsla,
    pub(crate) dot_fill: Hsla,
}

impl Spec {
    /// The largest value on the value axis: the tallest stack, or the largest value.
    pub(crate) fn max_value(&self) -> f64 {
        (0..self.categories.len())
            .map(|index| {
                let at = |series: &DrawnSeries| series.values.get(index).copied().unwrap_or(0.);
                if self.stacked {
                    self.series.iter().map(at).sum::<f64>()
                } else {
                    self.series.iter().map(at).fold(0., f64::max)
                }
            })
            .fold(0., f64::max)
    }
}

/// A grey of `level` (0 to 1) at `alpha`: recharts' fixed `#666`, `#ccc` and white.
fn grey(level: f32, alpha: f32) -> Hsla {
    crate::ui::convert::hsla(crate::tokens::Rgba {
        r: level,
        g: level,
        b: level,
        a: alpha,
    })
}

#[derive(IntoElement)]
pub struct Chart {
    id: ElementId,
    kind: Kind,
    categories: Vec<SharedString>,
    series: Vec<Series>,
    stacked: bool,
    unit: SharedString,
    margin: Margin,
    y_width: f32,
    allow_decimals: bool,
    title: TooltipTitle,
    size: Size,
}

impl Chart {
    pub fn new(
        id: impl Into<ElementId>,
        kind: Kind,
        categories: impl IntoIterator<Item = impl Into<SharedString>>,
        series: Vec<Series>,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            categories: categories.into_iter().map(Into::into).collect(),
            series,
            stacked: false,
            unit: SharedString::default(),
            margin: Margin::DEFAULT,
            y_width: 60., // recharts YAxis `width`
            allow_decimals: true,
            title: TooltipTitle::Category,
            size: Size::Default,
        }
    }

    /// The series share one bar per category (`stackId`).
    pub fn stacked(mut self) -> Self {
        self.stacked = true;
        self
    }

    /// Appended to every value-axis label (`unit`).
    pub fn unit(mut self, unit: impl Into<SharedString>) -> Self {
        self.unit = unit.into();
        self
    }

    pub fn margin(mut self, margin: Margin) -> Self {
        self.margin = margin;
        self
    }

    /// The value axis' width (`YAxis width`, 60 by default).
    pub fn y_axis_width(mut self, width: f32) -> Self {
        self.y_width = width;
        self
    }

    /// `allowDecimals={false}`: whole-number ticks.
    pub fn whole_ticks(mut self) -> Self {
        self.allow_decimals = false;
        self
    }

    pub fn tooltip_title(mut self, title: TooltipTitle) -> Self {
        self.title = title;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }
}

/// Where the pointer is over the chart (chart-local) and the chart's last size.
#[derive(Clone, Copy, Default)]
struct Pointer {
    /// In window coordinates.
    at: Option<Point<Pixels>>,
    origin: Point<Pixels>,
    size: gpui::Size<Pixels>,
}

impl Chart {
    /// The data with its colours resolved against the theme.
    fn resolve(self, ds: &Ds) -> Spec {
        Spec {
            kind: self.kind,
            categories: self.categories,
            series: self
                .series
                .into_iter()
                .map(|series| DrawnSeries {
                    name: series.name,
                    color: ds.color(series.color.token()),
                    values: series.values,
                })
                .collect(),
            stacked: self.stacked,
            unit: self.unit,
            margin: self.margin,
            y_width: self.y_width,
            allow_decimals: self.allow_decimals,
            title: self.title,
            family: ds.body_font().clone(),
            grid: ds.color(Color::Line),
            tick: grey(0.4, 1.),
            cursor: grey(0.8, 0.5),
            dot_fill: grey(1., 1.),
        }
    }
}

impl RenderOnce for Chart {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (id, size) = (self.id.clone(), self.size);
        let spec = Rc::new(self.resolve(ds));
        let state = window.use_keyed_state((id.clone(), "pointer"), cx, |_, _| Pointer::default());
        let pointer = *state.read(cx);
        let ds = Ds::get(cx);
        let plot = paint::Plot::new(
            &spec,
            f32::from(pointer.size.width),
            f32::from(pointer.size.height),
        );
        let local = pointer.at.map(|at| at - pointer.origin);
        let active = local.and_then(|at| plot.index_at(&spec, f32::from(at.x), f32::from(at.y)));
        let drawn = spec.clone();
        let record = state.clone();
        let surface = canvas(
            |bounds, _, _| bounds,
            move |bounds: Bounds<Pixels>, _, window, cx| {
                let seen = *record.read(cx);
                if seen.size != bounds.size || seen.origin != bounds.origin {
                    record.update(cx, |pointer, _| {
                        pointer.size = bounds.size;
                        pointer.origin = bounds.origin;
                    });
                    window.request_animation_frame();
                }
                paint::chart((window, cx), bounds, &drawn, active);
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let (moved, left) = (state.clone(), state.clone());
        let anchor = id.to_string();
        let tooltip = active
            .zip(local)
            .map(|(index, at)| tooltip::content(&spec, index, at, pointer.size, ds));
        let mut root = div()
            .id(id.clone())
            .debug_selector(move || anchor.clone())
            .relative()
            .w_full()
            .max_w_full()
            .on_mouse_move(move |event: &MouseMoveEvent, _, cx| {
                moved.update(cx, |pointer, cx| {
                    pointer.at = Some(event.position);
                    cx.notify();
                });
            })
            .on_hover(move |over, _, cx| {
                if !*over {
                    left.update(cx, |pointer, cx| {
                        pointer.at = None;
                        cx.notify();
                    });
                }
            })
            .child(surface);
        root = match size {
            Size::Default => root.h(px(150.)).min_w(px(220.)),
            Size::Panel => root.h(ds.len(Length::ChartHeightPanel)).min_w_0(),
        };
        root.children(tooltip)
    }
}
