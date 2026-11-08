//! `usage/UsageReadout.tsx` in its `panel` layout, and `usageParts` with request counts.
use std::rc::Rc;

use butler_ds::tokens::Color;
use butler_ds::ui::animated_number::AnimatedNumber;
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, SwatchPattern, ValueSize};
use butler_ds::ui::blocks::usage_bars::Emphasis;
use butler_ds::ui::blocks::usage_summary_rows::format_usd;
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Basis, Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::skeleton::{Height, Skeleton, Width};
use butler_ds::ui::typo::{Role, Typo};
use gpui::{AnyElement, App, ElementId, IntoElement as _, ParentElement as _, Window};

use super::copy::words;
use super::format::count;
use super::wire::Monitor;
use crate::ui::composer::context::timeline::{Readout, TimelineBucket, usage_share, usage_tokens};
use crate::ui::i18n::composer::usage::copy;

/// Values after the start of a slot that carry its subtask requests, cached and output; shorter
/// slots have no per-type split.
const SPLIT_SLOT_VALUES: usize = 8;

/// One row of the total's split by who made the calls.
pub(super) struct Part {
    id: &'static str,
    emphasis: Emphasis,
    label: &'static str,
    value: String,
}

/// `usageParts(view, bucket, true)`: the total split into the chat's own calls and its delegated
/// work, with request counts; `None` when nothing was delegated or the response lacks the values.
pub(super) fn parts(
    view: Option<&Monitor>,
    bucket: Option<&TimelineBucket>,
    lang: Lang,
) -> Option<Vec<Part>> {
    let model = &view?.model;
    let subtasks = model.subtasks.as_ref().filter(|s| s.total_tokens > 0.)?;
    if bucket.is_some_and(|b| b.values.len() < SPLIT_SLOT_VALUES) {
        return None;
    }
    // Both parts share one basis: the view's totals for the chat, the slot's prompt + output for a bar.
    let (whole, delegated) = bucket
        .map_or((model.totals.total_tokens, subtasks.total_tokens), |b| {
            (b.total, b.delegated)
        });
    let main = (whole - delegated).max(0.);
    let calls = match bucket {
        Some(b) => {
            let delegated = b.values.get(5).copied().unwrap_or_default();
            [b.requests - delegated, delegated]
        }
        None => [
            model.totals.request_count - subtasks.request_count,
            subtasks.request_count,
        ],
    };
    let total = main + delegated;
    let c = copy(lang);
    let part = |id, emphasis, label, value: f64, calls: f64| Part {
        id,
        emphasis,
        label,
        value: [
            Some(usage_tokens(value, lang)),
            (total > 0.).then(|| usage_share(value / total, lang)),
            Some((c.requests)(&count(calls))),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · "),
    };
    Some(vec![
        part(
            "main",
            Emphasis::Conversation,
            c.conversation_part,
            main,
            calls[0],
        ),
        part(
            "delegated",
            Emphasis::Subtask,
            c.delegated_part,
            delegated,
            calls[1],
        ),
    ])
}

type EmphasisHandler = Rc<dyn Fn(Option<Emphasis>, &mut Window, &mut App)>;

pub(super) struct Props<'a> {
    pub(super) view: Option<&'a Monitor>,
    pub(super) values: Readout,
    /// The selected bar's name.
    pub(super) label: Option<&'a str>,
    pub(super) selected: bool,
    pub(super) delta: Option<String>,
    pub(super) share: Option<String>,
    pub(super) parts: Option<Vec<Part>>,
    pub(super) on_emphasis: EmphasisHandler,
    pub(super) lang: Lang,
}

/// `UsageReadout` with `panel` and `showCost`.
pub(super) fn readout(props: Props, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    Stack::new()
        .gap(Space::Sm)
        .child(header_row(&props))
        .child(total_row(&props))
        .child(series_rows(&props, ds))
        .child(parts_rows(props.parts, &props.on_emphasis, ds))
        .into_any_element()
}

fn header_row(props: &Props) -> AnyElement {
    let c = copy(props.lang);
    let view = props.view;
    let left = match (view.is_some(), props.label) {
        (true, Some(label)) => Some(
            Typo::caption(label.to_owned())
                .truncate()
                .grow()
                .basis(Basis::Zero)
                .min_width(MinWidth::Zero)
                .into_any_element(),
        ),
        (false, _) => Some(
            Skeleton::new("usage-readout-loading")
                .width(Width::Third)
                .into_any_element(),
        ),
        _ => None,
    };
    let requests = view.map_or_else(
        || "—".to_owned(),
        |_| (c.requests)(&count(props.values.requests)),
    );
    let justify = if view.is_some() && props.label.is_none() {
        Justify::End
    } else {
        Justify::Between
    };
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .justify(justify)
        .wrap(true)
        .children(left)
        .child(Typo::caption(requests).tabular())
        .into_any_element()
}

fn total_row(props: &Props) -> AnyElement {
    let (c, lang) = (copy(props.lang), props.lang);
    let total = if props.view.is_some() {
        AnimatedNumber::new("usage-total", props.values.total)
            .format(move |value| usage_tokens(value, lang))
            .role(Role::MetricValue)
            .into_any_element()
    } else {
        Typo::metric_value("—").tabular().into_any_element()
    };
    let delta = props
        .delta
        .clone()
        .filter(|_| !props.selected)
        .map(Typo::caption);
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Baseline)
        .justify(Justify::Between)
        .wrap(true)
        .child(
            Stack::row()
                .gap(Space::Xs)
                .cross(Cross::Baseline)
                .child(total)
                .child(Typo::caption(c.tokens))
                .children(delta),
        )
        .into_any_element()
}

/// The three token series, the estimated cost and the share of all usage.
fn series_rows(props: &Props, ds: &Ds) -> AnyElement {
    let (c, lang, values) = (copy(props.lang), props.lang, &props.values);
    let w = words(lang);
    let ratio = if values.prompt > 0. {
        (values.cached / values.prompt * 100.).round()
    } else {
        0.
    };
    let series = [
        (
            c.new_input,
            Color::ContextChart1,
            (values.prompt - values.cached).max(0.),
            false,
        ),
        (c.cached, Color::ContextChart5, values.cached, true),
        (c.output, Color::ContextChart2, values.output, false),
    ];
    let mut rows: Vec<AnyElement> = series
        .into_iter()
        .enumerate()
        .map(|(index, (label, color, tokens, cache))| {
            let suffix = if cache {
                format!(" · {ratio}%")
            } else {
                String::new()
            };
            let value = props
                .view
                .map(|_| format!("{}{suffix}", usage_tokens(tokens, lang)))
                .unwrap_or_default();
            let row = KeyValueRow::new(label, value)
                .value_size(ValueSize::Caption)
                .swatch_color(ds.color(color));
            if props.view.is_none() {
                row.value_element(
                    Skeleton::new((ElementId::from("usage-series-skeleton"), index.to_string()))
                        .width(Width::Ch(8.))
                        .height(Height::Line),
                )
                .into_any_element()
            } else {
                row.into_any_element()
            }
        })
        .collect();
    if !props.selected {
        rows.push(
            KeyValueRow::new(w.estimated_cost, cost_text(props.view, lang))
                .value_size(ValueSize::Caption)
                .into_any_element(),
        );
        if let Some(share) = &props.share {
            rows.push(
                KeyValueRow::new(w.share, share.clone())
                    .value_size(ValueSize::Caption)
                    .into_any_element(),
            );
        }
    }
    Stack::row()
        .gap(Space::Lg)
        .row_gap(Space::Xs)
        .wrap(true)
        .children(rows)
        .into_any_element()
}

/// The estimated cost: "—", "Less than $0.01" or the amount.
fn cost_text(view: Option<&Monitor>, lang: Lang) -> String {
    let usd = view
        .filter(|view| view.cost.available)
        .and_then(|view| view.cost.estimated_usd)
        .filter(|usd| *usd != 0.);
    match usd {
        None => "—".to_owned(),
        Some(usd) if usd < 0.01 => copy(lang).tiny_cost.to_owned(),
        Some(usd) => format_usd(usd),
    }
}

/// The split rows; a row's hover or focus links to the chart's emphasis.
fn parts_rows(parts: Option<Vec<Part>>, on_emphasis: &EmphasisHandler, ds: &Ds) -> AnyElement {
    let open = parts.as_ref().is_some_and(|parts| !parts.is_empty());
    let rows = parts.unwrap_or_default().into_iter().map(|part| {
        let (emphasis, handler) = (part.emphasis, on_emphasis.clone());
        KeyValueRow::new(part.label, part.value)
            .value_size(ValueSize::Caption)
            .swatch_color(ds.color(Color::ContextChart5))
            .swatch_pattern(if emphasis == Emphasis::Subtask {
                SwatchPattern::Hatched
            } else {
                SwatchPattern::Solid
            })
            .on_highlight_change(
                (ElementId::from("usage-part"), part.id),
                move |highlighted, window, cx| handler(highlighted.then_some(emphasis), window, cx),
            )
    });
    Collapsible::new("usage-parts", open)
        .child(
            Stack::row()
                .gap(Space::Lg)
                .row_gap(Space::Xs)
                .wrap(true)
                .children(rows),
        )
        .into_any_element()
}
