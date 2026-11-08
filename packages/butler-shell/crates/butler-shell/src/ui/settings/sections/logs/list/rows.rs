//! 목록's rows (`LogRows.tsx`, `LogRow.tsx`): newest first as one block, then More. Open, a row
//! shows its fields, its HTTP tabs or JSON, and a link to the whole message.
use butler_ds::ui::blocks::disclosure_row::{Attention, DisclosureRow};
use butler_ds::ui::blocks::key_value_row::{Detail, KeyValueRow, ValueSize};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Cross, Inline, Justify, Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};
use serde_json::Value;

use super::super::trace::TraceTarget;
use super::api::LogRecord;
use super::copy::LogsCopy;
use super::format::{
    format_duration, format_log_time, has_detail, http_attrs, log_title, pretty_json, record_key,
    severity_label, severity_of, severity_tone,
};
use super::{LogList, http};

/// A W3C trace ID, the only form GET /logs/trace/{id} accepts.
fn is_trace_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}

/// An error's message when it has one; otherwise the error as JSON.
fn error_text(error: &Value) -> String {
    match error {
        Value::String(text) => text.clone(),
        Value::Object(fields) if fields.len() == 1 => match fields.get("message") {
            Some(Value::String(message)) => message.clone(),
            _ => pretty_json(error),
        },
        other => pretty_json(other),
    }
}

impl LogList {
    pub(super) fn rows_block(&self, copy: &'static LogsCopy, cx: &mut Context<Self>) -> AnyElement {
        let rows = self
            .rows
            .rows
            .iter()
            .map(|record| self.row(record, copy, cx));
        let mut block = Stack::new()
            .gap(Space::Sm)
            .child(Stack::new().gap(Space::None).children(rows));
        if self.rows.next.is_some() {
            let more = Button::new("logs-more")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(copy.more)
                .on_click(cx.listener(|this, _, _, cx| this.load_more(cx)));
            block = block.child(if self.paging { more.disabled() } else { more });
        }
        block.into_any_element()
    }

    /// One record: message, level, category · process · duration and time.
    fn row(
        &self,
        record: &LogRecord,
        copy: &'static LogsCopy,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = record_key(record);
        let id = SharedString::from(format!("log-row-{key}"));
        let description = [
            Some(record.category.clone()).filter(|text| !text.is_empty()),
            Some(record.process.clone()).filter(|text| !text.is_empty()),
            record.duration_ms.map(format_duration),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let meta = Inline::new()
            .gap(Space::Xs)
            .wrap(false)
            .child(
                Tag::new(
                    SharedString::from(format!("{id}-level")),
                    severity_label(&record.level, copy),
                )
                .size(TagSize::Sm)
                .tone(severity_tone(&record.level)),
            )
            .child(
                Typo::caption(format_log_time(&record.ts))
                    .tone(Tone::Tertiary)
                    .tabular(),
            );
        let toggled = key.clone();
        let mut row = DisclosureRow::new(id, log_title(record))
            .description(description)
            .meta_element(meta)
            .open(self.open_key.as_ref() == Some(&key))
            .on_toggle(cx.listener(move |this, _, _, cx| this.toggle_row(toggled.clone(), cx)));
        match severity_of(&record.level) {
            Some(0) => row = row.attention(Attention::Error),
            Some(1) => row = row.attention(Attention::Warning),
            _ => {}
        }
        if has_detail(record) {
            row = row.child(self.detail(record, &key, copy, cx));
        }
        row.into_any_element()
    }

    fn detail(
        &self,
        record: &LogRecord,
        key: &str,
        copy: &'static LogsCopy,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut stack = Stack::new().gap(Space::Md).child(fields(record, key, copy));
        stack = stack.child(match http_attrs(record) {
            Some(attrs) => self.http_tabs(record, attrs, key, copy, cx),
            None => http::json(record, key, copy),
        });
        if let Some(trace_id) = record.trace_id.as_deref().filter(|id| is_trace_id(id)) {
            let open = self.open_trace.clone();
            let target = TraceTarget::Trace(trace_id.to_owned().into());
            let button = Button::new(SharedString::from(format!("log-trace-{key}")))
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(copy.view_whole)
                .on_click(move |_, window, cx| open(target.clone(), window, cx));
            stack = stack.child(Inline::new().justify(Justify::End).child(button));
        }
        stack.into_any_element()
    }
}

fn fields(record: &LogRecord, key: &str, copy: &'static LogsCopy) -> Stack {
    let caption = |label: &'static str, value: &str| {
        KeyValueRow::new(label, value.to_owned()).value_size(ValueSize::Caption)
    };
    let mut stack = Stack::new()
        .gap(Space::None)
        .child(caption(copy.time, &record.ts));
    if !record.msg.is_empty() && log_title(record) != record.msg {
        stack = stack.child(caption(copy.message, &record.msg));
    }
    stack = stack.child(caption(copy.event, &record.event));
    let ids = [
        (copy.trace, &record.trace_id),
        (copy.span, &record.span_id),
        (copy.chat, &record.chat_id),
        (copy.turn, &record.turn_id),
    ];
    for (label, value) in ids {
        if let Some(value) = value.as_deref().filter(|value| !value.is_empty()) {
            let value = id_value(&format!("{key}-{label}"), value, copy);
            stack = stack.child(KeyValueRow::new(label, "").value_element(value));
        }
    }
    if let Some(error) = &record.error {
        stack = stack.child(caption(copy.error, &error_text(error)).detail(Detail::Stack));
    }
    stack
}

fn id_value(id: &str, value: &str, copy: &'static LogsCopy) -> AnyElement {
    Inline::new()
        .gap(Space::Xs)
        .cross(Cross::Center)
        .wrap(false)
        .child(Typo::code(value.to_owned()))
        .child(
            CopyButton::new(
                SharedString::from(format!("log-copy-{id}")),
                copy.copy,
                copy.copied,
            )
            .text(value),
        )
        .into_any_element()
}
