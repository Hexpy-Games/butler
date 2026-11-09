//! One step of the trace (`TraceStepRow.tsx`, `TraceStepDetail.tsx`).
use butler_ds::ui::blocks::disclosure_row::{Affordance, DisclosureRow};
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::blocks::span_bar::{SpanBar, SpanIndent, SpanRow, SpanSegment, SpanTone};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, SharedString, Window,
};
use serde_json::Value;

use super::copy::Words;
use super::model::{Step, TraceSpan, TraceView, attention, http_span, is_http};
use super::text::{Field, format_ms, format_start, step_fields, step_tag, step_title};
use crate::ui::settings::controls::raw_block;

/// `stepTone`: the tone the record names; any other is an agent step.
fn tone(step: &Step) -> SpanTone {
    SpanTone::parse(&step.span.tone).unwrap_or(SpanTone::Agent)
}

/// The step's bar on the shared axis, split over its direct children's pieces.
fn bar(copy: &Words, id: &SharedString, steps: &[Step], index: usize, total: f64) -> SpanBar {
    let step = &steps[index];
    let pieces = step.children.iter().map(|child| SpanSegment {
        offset: steps[*child].offset,
        duration: steps[*child].duration,
        tone: tone(&steps[*child]),
    });
    SpanBar::new(
        SharedString::from(format!("{id}-bar")),
        step.offset,
        step.duration,
        total,
    )
    .tone(tone(step))
    .segments(pieces)
    .label(copy.spoken(
        &format_start(copy, step.offset),
        &format_ms(copy, step.duration),
    ))
}

/// One step: no chevron; a count and a problem dot by the title; a bar on the shared axis,
/// split into its direct children's pieces. A row with nothing to reveal is static.
pub(super) fn row(
    copy: &'static Words,
    trace: &TraceView,
    steps: &[Step],
    index: usize,
    total: f64,
    open: bool,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> SpanRow {
    let step = &steps[index];
    let id = SharedString::from(format!("trace-step-{}", step.span.span_id));
    let length = format_ms(copy, step.duration);
    let tag = step_tag(copy, steps, index).map(|(text, tone)| {
        Tag::new(SharedString::from(format!("{id}-tag")), text)
            .size(TagSize::Sm)
            .tone(tone)
    });
    let meta = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .children(tag)
        .child(Typo::caption(length).tone(Tone::Tertiary).tabular());
    let span = SpanRow::new(SharedString::from(format!("{id}-row")))
        .depth(step.depth)
        .indent(SpanIndent::Text)
        .depth_label(move |level| copy.depth(level).into());
    let (level, cue) = span.text_indent();
    let mut row = DisclosureRow::new(id.clone(), step_title(copy, step))
        .affordance(Affordance::None)
        .description(format_start(copy, step.offset))
        .meta_element(meta)
        .indent(level, cue)
        .open(open)
        .on_toggle(on_toggle)
        .bar(bar(copy, &id, steps, index, total));
    if !step.children.is_empty() {
        row = row.count(u32::try_from(step.children.len()).unwrap_or(u32::MAX));
    }
    if let Some(attention) = attention(step) {
        row = row.attention(attention);
    }
    match detail(copy, trace, step) {
        Some(detail) => span.child(row.child(detail)),
        None => span.child(row),
    }
}

/// An opened step: its fields, and for an HTTP exchange its request and response.
fn detail(copy: &Words, trace: &TraceView, step: &Step) -> Option<AnyElement> {
    let fields = step_fields(copy, step, trace);
    let http = is_http(step);
    if fields.is_empty() && !http {
        return None;
    }
    let rows = Stack::new()
        .gap(Space::None)
        .children(fields.into_iter().map(field_row));
    Some(
        Stack::new()
            .gap(Space::Md)
            .child(rows)
            .children(http.then(|| http_blocks(copy, step)))
            .into_any_element(),
    )
}

fn field_row(field: Field) -> KeyValueRow {
    KeyValueRow::new(field.label, field.value).value_size(ValueSize::Caption)
}

/// The request and response of an HTTP exchange, from the span's attributes.
// CARVE-OUT(U10 seam): React shows `LogHttpTabs` (request / response / JSON tabs, and the
// stored record's body, fetched once the row opens). The tabs live in U10's list files and the
// frame has no seam for them, so the span's own method, URL, status and headers show here.
fn http_blocks(copy: &Words, step: &Step) -> AnyElement {
    let span = http_span(step);
    let [method, url, status, headers] = copy.http_fields;
    let attr = |key: &str| span.attrs.as_ref().and_then(|attrs| attrs.get(key));
    let line = |label: &'static str, value: Option<String>| {
        value.map(|value| KeyValueRow::new(label, value))
    };
    let target = attr("url")
        .or_else(|| attr("route"))
        .or_else(|| attr("path"));
    let request_headers = attr("request_headers").or_else(|| attr("headers"));
    Stack::new()
        .gap(Space::Xs)
        .children(line(method, attr("method").map(plain)))
        .children(line(url, target.map(plain)))
        .children(header_block(
            span,
            "request-headers",
            headers,
            request_headers,
        ))
        .children(line(status, attr("status").map(plain)))
        .children(header_block(
            span,
            "response-headers",
            headers,
            attr("response_headers"),
        ))
        .into_any_element()
}

/// A scalar the way React's `String(value)` prints it.
fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `formatHeaders` in a `RawBlock`: one `name: value` per line, nothing when there are none.
fn header_block(
    span: &TraceSpan,
    part: &str,
    title: &'static str,
    value: Option<&Value>,
) -> Option<AnyElement> {
    let Value::Object(map) = value? else {
        return None;
    };
    let text = map
        .iter()
        .map(|(name, header)| format!("{name}: {}", plain(header)))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then(|| {
        let id = SharedString::from(format!("trace-{}-{part}", span.span_id));
        raw_block(id, title, text, true, false)
    })
}
