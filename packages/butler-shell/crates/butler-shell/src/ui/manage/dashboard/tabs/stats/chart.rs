//! `management/ProjectStatisticChart.tsx`: one statistic as a bar chart, a way to step through its
//! buckets and the records behind the chosen one.
//!
//! CARVE-OUT(G-ds): the DS Chart has no horizontal layout, so the duration chart draws vertical
//! bars; it has no bar click, no arrow-key selection and no dimming of the other bars, so a bucket
//! is chosen with the arrow buttons under the chart.
use std::rc::Rc;

use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::chart::{
    Chart, ChartColor, ChartLegend, Kind, LegendItem, Margin, Series, Size as ChartSize,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Border, Box as Frame, Inline, Radius, Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size as SegmentSize};
use butler_ds::ui::typo::Typo;
use gpui::{ClickEvent, Context, IntoElement, ParentElement as _, Render, SharedString, Window};

use super::Stats;
use super::sources::{FIRST, MORE, source_list};
use crate::ui::manage::dashboard::tabs::copy::{StatWords, Words, words};
use crate::ui::source::wire::DashboardStatisticSeries;

/// Which statistic a chart shows: its title and help text.
#[derive(Clone, Copy)]
pub(super) enum Heading {
    Flow,
    TaskFlow,
    Materials,
    Outcomes,
    Duration,
}

impl Heading {
    fn texts(self, words: &StatWords) -> (&'static str, &'static str) {
        match self {
            Self::Flow => (words.flow, words.flow_help),
            Self::TaskFlow => (words.flow, words.task_completion_unavailable),
            Self::Materials => (words.materials, words.materials_help),
            Self::Outcomes => (words.outcomes, words.outcomes_help),
            Self::Duration => (words.duration, words.duration_help),
        }
    }
}

/// `TONES`: the series colors, the bars and the legend share them.
fn tone(key: &str) -> ChartColor {
    match key {
        "completed" | "delivered" => ChartColor::Success,
        "executed" | "artifacts" => ChartColor::Chart4,
        "failed" => ChartColor::Danger,
        "cancelled" => ChartColor::Chart5,
        "updated" | "plan" => ChartColor::Chart2,
        "report" => ChartColor::Chart3,
        _ => ChartColor::Chart1,
    }
}

/// `bucket.label`'s chart text: its name, else the label without the year (`slice(5)`).
fn bucket_text(words: &StatWords, label: &str) -> String {
    words
        .label(label)
        .map_or_else(|| label.chars().skip(5).collect(), str::to_owned)
}

pub(super) struct StatChart {
    id: SharedString,
    stats: Rc<Stats>,
    heading: Heading,
    stacked: bool,
    /// The series, each with the label key of the control that switches to it.
    variants: Vec<(&'static str, DashboardStatisticSeries)>,
    variant: usize,
    selected: Option<usize>,
    metric: Option<String>,
    limit: usize,
}

impl StatChart {
    pub(super) fn new(
        id: &str,
        heading: Heading,
        variants: Vec<(&'static str, DashboardStatisticSeries)>,
        stacked: bool,
        stats: Rc<Stats>,
    ) -> Self {
        Self {
            id: id.to_owned().into(),
            stats,
            heading,
            stacked,
            variants,
            variant: 0,
            selected: None,
            metric: None,
            limit: FIRST,
        }
    }

    fn series(&self) -> Option<&DashboardStatisticSeries> {
        self.variants
            .get(self.variant)
            .or_else(|| self.variants.first())
            .map(|(_, series)| series)
    }

    /// The chart is keyed by its view in React: a new view starts with nothing chosen.
    fn set_variant(&mut self, value: &str, cx: &mut Context<Self>) {
        if let Some(index) = self.variants.iter().position(|(name, _)| *name == value) {
            self.variant = index;
            self.selected = None;
            self.metric = None;
            self.limit = FIRST;
            cx.notify();
        }
    }

    /// `select(index)`
    fn select(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
        let count = self.series().map_or(0, |series| series.buckets.len());
        if let Some(index) = index.filter(|index| *index < count) {
            self.selected = Some(index);
            self.metric = None;
            self.limit = FIRST;
            cx.notify();
        }
    }

    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let count = self.series().map_or(0, |series| series.buckets.len());
        let next = if forward {
            self.selected
                .map_or(0, |selected| selected + 1)
                .min(count.saturating_sub(1))
        } else {
            self.selected.unwrap_or(count).saturating_sub(1)
        };
        self.select(Some(next), cx);
    }

    fn set_metric(&mut self, metric: Option<String>, cx: &mut Context<Self>) {
        self.metric = metric;
        self.limit = FIRST;
        cx.notify();
    }

    /// `SegmentedControl` of the views (the materials' "types" and "changes").
    fn switcher(&self, words: &'static Words, cx: &mut Context<Self>) -> SegmentedControl {
        SegmentedControl::new(
            SharedString::from(format!("{}-view", self.id)),
            words.materials_view,
            self.variants
                .get(self.variant)
                .map_or("", |(name, _)| *name),
        )
        .size(SegmentSize::Sm)
        .options(
            self.variants
                .iter()
                .map(|(name, _)| Choice::new(*name, words.stats.label(name).unwrap_or(*name))),
        )
        .on_value_change(cx.listener(|this, value: &str, _, cx| this.set_variant(value, cx)))
    }

    fn plot(&self, series: &DashboardStatisticSeries, words: &StatWords) -> Chart {
        let categories = series
            .buckets
            .iter()
            .map(|bucket| bucket_text(words, &bucket.label));
        let lines = series.keys.iter().map(|key| Series {
            name: words.label_or(key).into(),
            color: tone(key),
            values: series
                .buckets
                .iter()
                .map(|bucket| {
                    #[expect(clippy::cast_precision_loss, reason = "a count of records")]
                    let count = bucket.values.get(key).map_or(0, Vec::len) as f64;
                    count
                })
                .collect(),
        });
        let chart = Chart::new(
            SharedString::from(format!("{}-chart", self.id)),
            Kind::Bar,
            categories,
            lines.collect(),
        )
        .whole_ticks()
        .size(ChartSize::Panel)
        .y_axis_width(32.)
        .margin(Margin {
            left: 0.,
            right: 8.,
            top: 8.,
            bottom: 0.,
        });
        if self.stacked { chart.stacked() } else { chart }
    }

    fn stepper(
        &self,
        series: &DashboardStatisticSeries,
        words: &StatWords,
        cx: &mut Context<Self>,
    ) -> Stack {
        let selection = self
            .selected
            .and_then(|index| series.buckets.get(index))
            .map_or(words.selected.to_owned(), |bucket| {
                bucket_text(words, &bucket.label)
            });
        let arrow = |id: &str, text: &'static str, forward: bool, cx: &mut Context<Self>| {
            Button::new(SharedString::from(format!("{}-{id}", self.id)))
                .variant(Variant::Inline)
                .size(ButtonSize::Sm)
                .text(text)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.step(forward, cx)))
        };
        Inline::new()
            .child(arrow("previous", "←", false, cx))
            .child(arrow("next", "→", true, cx))
            .child(Typo::caption(selection))
    }

    fn details(
        &self,
        series: &DashboardStatisticSeries,
        words: &'static StatWords,
        cx: &mut Context<Self>,
    ) -> Option<Stack> {
        let bucket = series.buckets.get(self.selected?)?;
        let all = Button::new(SharedString::from(format!("{}-all", self.id)))
            .variant(if self.metric.is_some() {
                Variant::Borderless
            } else {
                Variant::Outline
            })
            .size(ButtonSize::Sm)
            .text(words.all)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_metric(None, cx)));
        let mut metrics = Inline::new().child(all);
        for key in &series.keys {
            let count = bucket.values.get(key).map_or(0, Vec::len);
            let chosen = self.metric.as_deref() == Some(key.as_str());
            let name = key.clone();
            metrics = metrics.child(
                Button::new(SharedString::from(format!("{}-metric-{key}", self.id)))
                    .variant(if chosen {
                        Variant::Outline
                    } else {
                        Variant::Borderless
                    })
                    .size(ButtonSize::Sm)
                    .text(format!("{} {count}", words.label_or(key)))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.set_metric(Some(name.clone()), cx);
                    })),
            );
        }
        let keys: Vec<String> = match &self.metric {
            Some(metric) => bucket.values.get(metric).cloned().unwrap_or_default(),
            None => bucket.values.values().flatten().cloned().collect(),
        };
        let more = cx.listener(|this, _: &ClickEvent, _, cx| {
            this.limit += MORE;
            cx.notify();
        });
        let id = format!("{}-sources", self.id);
        Some(
            Stack::new()
                .gap(Space::Md)
                .child(metrics)
                .child(source_list(&id, &keys, self.limit, &self.stats, more, cx)),
        )
    }
}

impl Render for StatChart {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let all = words(Ds::get(cx).lang());
        let words = &all.stats;
        let (title, help) = self.heading.texts(words);
        let mut section = Section::new(self.id.clone()).title(title).description(help);
        if self.variants.len() > 1 {
            section = section.actions(self.switcher(all, cx));
        }
        let mut body = Stack::new().gap(Space::Md);
        match self.series() {
            Some(series)
                if series
                    .buckets
                    .iter()
                    .any(|b| b.values.values().any(|v| !v.is_empty())) =>
            {
                let legend = series
                    .keys
                    .iter()
                    .map(|key| LegendItem::new(words.label_or(key), tone(key)));
                body = body
                    .child(ChartLegend::new(legend))
                    .child(self.plot(series, words))
                    .child(self.stepper(series, words, cx))
                    .children(self.details(series, words, cx));
            }
            Some(series) => {
                let text = if series.keys.is_empty() {
                    words.unavailable
                } else {
                    words.empty
                };
                body = body.child(Typo::caption(text));
            }
            None => {}
        }
        section.child(
            Frame::new()
                .border(Border::Hairline)
                .radius(Radius::Control)
                .padding_x(Space::Lg)
                .padding_y(Space::Md)
                .child(body),
        )
    }
}
