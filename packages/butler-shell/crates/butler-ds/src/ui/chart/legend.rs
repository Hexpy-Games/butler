//! DS ChartLegend and LegendSwatch (ChartLegend.tsx / LegendSwatch.tsx / Chart.module.css): a
//! wrapping row of labelled colour swatches for a chart's series.
use gpui::{App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window, div};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::typo::Typo;

/// The chart colours (`CHART_COLORS`): six context colours and the three status colours.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartColor {
    Chart1,
    Chart2,
    Chart3,
    Chart4,
    Chart5,
    Chart6,
    Success,
    Warning,
    Danger,
}

impl ChartColor {
    /// `CHART_COLORS`, in order.
    pub const ALL: [Self; 9] = [
        Self::Chart1,
        Self::Chart2,
        Self::Chart3,
        Self::Chart4,
        Self::Chart5,
        Self::Chart6,
        Self::Success,
        Self::Warning,
        Self::Danger,
    ];

    /// The token's name, as the viewer's legend labels it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Chart1 => "chart-1",
            Self::Chart2 => "chart-2",
            Self::Chart3 => "chart-3",
            Self::Chart4 => "chart-4",
            Self::Chart5 => "chart-5",
            Self::Chart6 => "chart-6",
            Self::Success => "success",
            Self::Warning => "warning",
            Self::Danger => "danger",
        }
    }

    pub(crate) fn token(self) -> Color {
        match self {
            Self::Chart1 => Color::ContextChart1,
            Self::Chart2 => Color::ContextChart2,
            Self::Chart3 => Color::ContextChart3,
            Self::Chart4 => Color::ContextChart4,
            Self::Chart5 => Color::ContextChart5,
            Self::Chart6 => Color::ContextChart6,
            Self::Success => Color::ColorSuccess,
            Self::Warning => Color::ColorWarning,
            Self::Danger => Color::ColorDanger,
        }
    }
}

/// `dot` for points and bars in a key, `bar` for a series line or stacked band.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SwatchShape {
    #[default]
    Dot,
    Bar,
}

/// A decorative colour key; pair it with a text label.
#[derive(IntoElement)]
pub struct LegendSwatch {
    color: ChartColor,
    shape: SwatchShape,
}

impl LegendSwatch {
    pub fn new(color: ChartColor) -> Self {
        Self {
            color,
            shape: SwatchShape::Dot,
        }
    }

    pub fn shape(mut self, shape: SwatchShape) -> Self {
        self.shape = shape;
        self
    }
}

impl RenderOnce for LegendSwatch {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (width, height) = match self.shape {
            SwatchShape::Dot => (Length::SpaceSm, Length::SpaceSm),
            SwatchShape::Bar => (Length::SpaceMd, Length::SpaceXs),
        };
        div()
            .flex_none()
            .w(ds.len(width))
            .h(ds.len(height))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(self.color.token()))
    }
}

/// One series of a legend.
pub struct LegendItem {
    label: SharedString,
    color: ChartColor,
    shape: SwatchShape,
}

impl LegendItem {
    pub fn new(label: impl Into<SharedString>, color: ChartColor) -> Self {
        Self {
            label: label.into(),
            color,
            shape: SwatchShape::Dot,
        }
    }

    pub fn shape(mut self, shape: SwatchShape) -> Self {
        self.shape = shape;
        self
    }
}

#[derive(IntoElement)]
pub struct ChartLegend {
    items: Vec<LegendItem>,
}

impl ChartLegend {
    pub fn new(items: impl IntoIterator<Item = LegendItem>) -> Self {
        Self {
            items: items.into_iter().collect(),
        }
    }
}

impl RenderOnce for ChartLegend {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .flex()
            .flex_wrap()
            .gap_x(ds.len(Length::SpaceLg))
            .gap_y(ds.len(Length::SpaceSm))
            .children(self.items.into_iter().map(|item| {
                div()
                    .flex()
                    .items_center()
                    .min_w_0()
                    .gap(ds.len(Length::SpaceXs))
                    .child(LegendSwatch::new(item.color).shape(item.shape))
                    .child(Typo::caption(item.label))
            }))
    }
}
