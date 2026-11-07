//! `ContextUsagePopover.tsx`, `usage/UsageReadout.tsx` and the popover layout of
//! `chatgpt/ChatGptPlanUsage.tsx` + `settings/ProviderQuotaGauge.tsx`: the context meter, this
//! chat's usage for the model's billing mode, the account limits and Details.
use std::rc::Rc;

use butler_ds::tokens::Color;
use butler_ds::ui::animated_number::{AnimatedNumber, grouped};
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, SwatchPattern, ValueSize};
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::blocks::usage_bars::{
    Emphasis, Size as BarsSize, State as BarsState, UsageBars,
};
use butler_ds::ui::blocks::usage_summary_rows::{format_tokens, format_usd};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant as ButtonVariant};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Basis, Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::skeleton::{Height, Skeleton, Width};
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement as _, ParentElement as _, SharedString,
    Window,
};

use super::account::account_section;
use super::timeline::{
    Readout, Timeline, usage_parts, usage_readout, usage_series, usage_timeline, usage_tokens,
};
use super::usage::{
    ConversationUsage, UsageAuthMode, UsageMonitorView, UsageStatus, clock,
    conversation_usage_summary, now_ms, parse_ms,
};
use crate::ui::i18n::composer::usage::copy;
use crate::ui::source::wire::ContextDetailsView;

pub(super) type SelectHandler = Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>;
pub(super) type EmphasisHandler = Rc<dyn Fn(Option<Emphasis>, &mut Window, &mut App)>;
pub(super) type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

pub(super) struct Props<'a> {
    pub(super) context: &'a ContextDetailsView,
    pub(super) mode: UsageAuthMode,
    pub(super) usage: ConversationUsage<'a>,
    pub(super) selected: Option<usize>,
    pub(super) emphasis: Option<Emphasis>,
    pub(super) lang: Lang,
    pub(super) on_select: SelectHandler,
    pub(super) on_emphasis: EmphasisHandler,
    pub(super) on_details: ClickHandler,
}

pub(super) fn eid(name: &'static str) -> ElementId {
    (ElementId::from("context-usage"), name).into()
}

pub(super) fn caption(text: impl Into<SharedString>) -> Typo {
    Typo::caption(text)
}

/// A request count with digit grouping.
fn count_text(value: f64) -> String {
    grouped(value.round())
}

/// `ContextUsagePopover`.
pub(super) fn usage_popover(props: &Props, cx: &App) -> AnyElement {
    let c = copy(props.lang);
    let context = props.context;
    let usage = &props.usage;
    let timeline = usage_timeline(usage.view, 24, props.lang);
    let bucket = props.selected.and_then(|index| timeline.buckets.get(index));
    let parts = usage_parts(usage.view, bucket, props.lang);
    let mut body = Stack::new()
        .gap(Space::Lg)
        .child(context_meter(context, props.lang));
    if props.mode.tracked() {
        body = body.child(Separator::new());
        body = body.child(
            if usage.view.is_none() && usage.status == UsageStatus::Failed {
                Stack::new()
                    .gap(Space::Sm)
                    .child(caption(c.this_chat))
                    .child(caption(c.unavailable))
                    .into_any_element()
            } else {
                readout(props, &timeline, parts, cx)
            },
        );
    }
    let summary = conversation_usage_summary(props.mode, context, usage, now_ms(), props.lang);
    if let (UsageAuthMode::Subscription, Some(summary)) = (props.mode, summary) {
        body = body
            .child(Separator::new())
            .child(account_section(summary, props.lang));
    }
    let on_details = props.on_details.clone();
    body.child(
        Stack::row().justify(Justify::End).child(
            Button::new("context-usage-details")
                .size(ButtonSize::Sm)
                .variant(ButtonVariant::Inline)
                .text(c.details)
                .on_click(move |event, window, cx| on_details(event, window, cx)),
        ),
    )
    .into_any_element()
}

fn context_meter(context: &ContextDetailsView, lang: Lang) -> AnyElement {
    let c = copy(lang);
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a percentage between 0 and 100"
    )]
    let percent = (context.ratio.clamp(0., 1.) * 100.).round() as i64;
    #[expect(clippy::cast_precision_loss, reason = "token counts display compactly")]
    let tokens = |value: i64| format_tokens(value as f64, lang);
    let compact = context
        .auto_compact_at_tokens
        .map(|at| format!(" · {}", (c.context_compact)(&tokens(at))))
        .unwrap_or_default();
    Stack::new()
        .gap(Space::Xs)
        .child(
            ProgressMeter::new(
                eid("context-meter"),
                f32::from(u8::try_from(percent).unwrap_or(100)),
            )
            .label(c.context_window)
            .meta((c.context_full)(percent)),
        )
        .child(
            caption(format!(
                "{} / {}{compact}",
                tokens(context.used_tokens),
                tokens(context.budget_tokens)
            ))
            .tabular()
            .tone(Tone::Secondary),
        )
        .into_any_element()
}

/// `UsageReadout` (popover layout) around the usage bars.
fn readout(
    props: &Props,
    timeline: &Timeline,
    parts: Option<Vec<super::timeline::Part>>,
    cx: &App,
) -> AnyElement {
    let c = copy(props.lang);
    let lang = props.lang;
    let view = props.usage.view;
    let bucket = props.selected.and_then(|index| timeline.buckets.get(index));
    let values = usage_readout(view, bucket);
    let label = bucket.map_or(c.this_chat, |b| b.label.as_str()).to_owned();
    let selected = bucket.is_some();
    let bars = bars(props, timeline, parts.is_some());
    if view.is_some() && !selected && values.total == 0. && values.requests == 0. {
        return Stack::new()
            .gap(Space::Sm)
            .child(caption(label))
            .child(bars)
            .into_any_element();
    }
    let unit = (timeline.step_hours > 1).then(|| (c.bucket_unit)(timeline.step_hours));
    let show_cost = props.mode == UsageAuthMode::ApiKey && !selected;
    Stack::new()
        .gap(Space::Sm)
        .child(header_row(view, &label, &values, unit, lang))
        .child(total_row(view, &values, show_cost, lang))
        .children(
            (props.usage.status == UsageStatus::Failed)
                .then(|| {
                    let at = view.and_then(|v| parse_ms(&v.generated_at))?;
                    Some(caption((c.updated)(&clock(
                        at + super::usage::local_offset_ms(),
                    ))))
                })
                .flatten(),
        )
        .child(bars)
        .child(series_rows(view, &values, lang, Ds::get(cx)))
        .child(parts_rows(parts, &props.on_emphasis, Ds::get(cx)))
        .into_any_element()
}

fn header_row(
    view: Option<&UsageMonitorView>,
    label: &str,
    values: &Readout,
    unit: Option<String>,
    lang: Lang,
) -> AnyElement {
    let c = copy(lang);
    let left = if view.is_some() {
        caption(label.to_owned())
            .truncate()
            .grow()
            .basis(Basis::Zero)
            .min_width(MinWidth::Zero)
            .into_any_element()
    } else {
        Skeleton::new(eid("loading-label"))
            .width(Width::Third)
            .into_any_element()
    };
    let requests = if view.is_some() {
        (c.requests)(&count_text(values.requests))
    } else {
        "—".to_owned()
    };
    let right = format!(
        "{requests}{}",
        unit.map(|u| format!(" · {u}")).unwrap_or_default()
    );
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .justify(Justify::Between)
        .child(left)
        .child(caption(right).tabular())
        .into_any_element()
}

fn total_row(
    view: Option<&UsageMonitorView>,
    values: &Readout,
    show_cost: bool,
    lang: Lang,
) -> AnyElement {
    let c = copy(lang);
    let total = if view.is_some() {
        AnimatedNumber::new(eid("total"), values.total)
            .format(move |value| usage_tokens(value, lang))
            .role(Role::MetricValue)
            .into_any_element()
    } else {
        Typo::metric_value("—").tabular().into_any_element()
    };
    let cost = show_cost.then(|| {
        let usd = view
            .filter(|v| v.cost.available)
            .and_then(|v| v.cost.estimated_usd)
            .filter(|usd| *usd != 0.);
        let text = match usd {
            None => "—".to_owned(),
            Some(usd) if usd < 0.01 => c.tiny_cost.to_owned(),
            Some(usd) => format_usd(usd),
        };
        caption(format!("{text} · {}", c.estimate))
    });
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
                .child(caption(c.tokens)),
        )
        .children(cost)
        .into_any_element()
}

fn bars(props: &Props, timeline: &Timeline, has_parts: bool) -> AnyElement {
    let c = copy(props.lang);
    let on_select = props.on_select.clone();
    let bars = UsageBars::new(
        eid("bars"),
        timeline.buckets.iter().map(|b| b.bar.clone()).collect(),
        usage_series(c),
    )
    .size(BarsSize::Popover)
    .selected(props.selected)
    .on_select(move |index, window, cx| on_select(index, window, cx))
    .axis_labels(timeline.axis_labels.clone())
    .emphasis(if has_parts { props.emphasis } else { None })
    .state(if props.usage.view.is_none() {
        BarsState::Loading
    } else {
        BarsState::Ready
    })
    .empty_label(c.no_usage);
    if timeline.buckets.len() == 1 {
        bars.note(c.just_started).into_any_element()
    } else {
        bars.into_any_element()
    }
}

fn series_rows(
    view: Option<&UsageMonitorView>,
    values: &Readout,
    lang: Lang,
    ds: &Ds,
) -> AnyElement {
    let c = copy(lang);
    let ratio = if values.prompt > 0. {
        (values.cached / values.prompt * 100.).round()
    } else {
        0.
    };
    let rows = [
        (
            c.new_input,
            Color::ContextChart1,
            (values.prompt - values.cached).max(0.),
            false,
        ),
        (c.cached, Color::ContextChart5, values.cached, true),
        (c.output, Color::ContextChart2, values.output, false),
    ];
    Stack::new()
        .gap(Space::None)
        .children(
            rows.into_iter()
                .enumerate()
                .map(|(index, (label, color, tokens, cache))| {
                    let suffix = if cache {
                        format!(" · {ratio}%")
                    } else {
                        String::new()
                    };
                    let value = view
                        .map(|_| format!("{}{suffix}", usage_tokens(tokens, lang)))
                        .unwrap_or_default();
                    let row = KeyValueRow::new(label, value)
                        .value_size(ValueSize::Caption)
                        .swatch_color(ds.color(color));
                    if view.is_none() {
                        row.value_element(
                            Skeleton::new((eid("series-skeleton"), index.to_string()))
                                .width(Width::Ch(8.))
                                .height(Height::Line),
                        )
                    } else {
                        row
                    }
                }),
        )
        .into_any_element()
}

fn parts_rows(
    parts: Option<Vec<super::timeline::Part>>,
    on_emphasis: &EmphasisHandler,
    ds: &Ds,
) -> AnyElement {
    let open = parts.as_ref().is_some_and(|p| !p.is_empty());
    let rows = parts.unwrap_or_default().into_iter().map(|part| {
        let emphasis = part.emphasis;
        let handler = on_emphasis.clone();
        KeyValueRow::new(part.label, part.value)
            .value_size(ValueSize::Caption)
            .swatch_color(ds.color(Color::ContextChart5))
            .swatch_pattern(if emphasis == Emphasis::Subtask {
                SwatchPattern::Hatched
            } else {
                SwatchPattern::Solid
            })
            .on_highlight_change((eid("part"), part.id), move |highlighted, window, cx| {
                handler(highlighted.then_some(emphasis), window, cx);
            })
    });
    Collapsible::new(eid("parts"), open)
        .child(Stack::new().gap(Space::None).children(rows))
        .into_any_element()
}
