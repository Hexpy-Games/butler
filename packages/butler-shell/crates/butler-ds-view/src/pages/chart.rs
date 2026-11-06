//! Chart.showcase.tsx: stacked bars with their legend, the legend colours and shapes. Plus a
//! native check with no React counterpart: the answer chart (grouped bars and a line).
use butler_ds::ui::chart::{
    Chart, ChartColor, ChartLegend, Kind, LegendItem, Margin, Series, Size, SwatchShape,
    TooltipTitle,
};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Stacked bars with legend",
            render: work_chart,
        },
        Story {
            name: "Legend colors",
            render: colors,
        },
        Story {
            name: "Legend shapes",
            render: shapes,
        },
        Story {
            name: "Answer chart: grouped bars and a line (native check)",
            render: answer,
        },
    ]
}

const VALUES: [[f64; 3]; 5] = [
    [4., 3., 0.],
    [6., 4., 1.],
    [3., 5., 0.],
    [7., 5., 2.],
    [5., 6., 1.],
];

fn work_chart(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (names, days) = lang.pick(
        (
            ["Created", "Completed", "Failed"],
            ["Mon", "Tue", "Wed", "Thu", "Fri"],
        ),
        (["생성", "완료", "실패"], ["월", "화", "수", "목", "금"]),
    );
    let colors = [ChartColor::Chart1, ChartColor::Success, ChartColor::Danger];
    let series: Vec<Series> = (0..3)
        .map(|index| Series {
            name: names[index].into(),
            color: colors[index],
            values: VALUES.iter().map(|row| row[index]).collect(),
        })
        .collect();
    Stack::new()
        .gap(Space::Md)
        .child(ChartLegend::new(
            (0..3).map(|index| LegendItem::new(names[index], colors[index])),
        ))
        .child(
            Chart::new("chart-work", Kind::Bar, days, series)
                .stacked()
                .size(Size::Panel)
                .margin(Margin {
                    left: 0.,
                    right: 8.,
                    top: 8.,
                    bottom: 0.,
                })
                .y_axis_width(24.)
                .whole_ticks(),
        )
        .into_any_element()
}

fn colors(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ChartLegend::new(
        ChartColor::ALL
            .into_iter()
            .map(|color| LegendItem::new(color.name(), color)),
    )
    .into_any_element()
}

fn shapes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (created, failed) = lang.pick(("Created", "Failed"), ("생성", "실패"));
    ChartLegend::new([
        LegendItem::new(format!("{created} (dot)"), ChartColor::Chart1),
        LegendItem::new(format!("{failed} (bar)"), ChartColor::Danger).shape(SwatchShape::Bar),
    ])
    .into_any_element()
}

/// AnswerChart: the answer block's chart with recharts' defaults (5px margin, 60px value axis,
/// a unit on the value labels, the first series' name as the tooltip title).
fn answer(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (names, days) = lang.pick(
        (["Sessions", "Tasks"], ["Mon", "Tue", "Wed", "Thu", "Fri"]),
        (["세션", "작업"], ["월", "화", "수", "목", "금"]),
    );
    let data = [[12., 8.], [18., 14.], [9., 11.], [21., 16.], [15., 19.]];
    let series = |color: ChartColor, index: usize| Series {
        name: names[index].into(),
        color,
        values: data.iter().map(|row| row[index]).collect(),
    };
    let legend = ChartLegend::new([
        LegendItem::new(names[0], ChartColor::Chart1),
        LegendItem::new(names[1], ChartColor::Chart2),
    ]);
    let plot = |id: &'static str, kind: Kind| {
        Chart::new(
            id,
            kind,
            days,
            vec![series(ChartColor::Chart1, 0), series(ChartColor::Chart2, 1)],
        )
        .size(Size::Panel)
        .unit("%")
        .tooltip_title(TooltipTitle::FirstSeries)
    };
    Stack::new()
        .gap(Space::Sm)
        .child(legend)
        .child(plot("chart-answer-bar", Kind::Bar))
        .child(plot("chart-answer-line", Kind::Line))
        .into_any_element()
}
