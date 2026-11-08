//! 요청 / 응답 / JSON for a record with HTTP attributes (`LogHttpTabs.tsx`, `LogJson.tsx`).
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Inline, Justify, Space, Stack};
use butler_ds::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};
use serde_json::{Map, Value};

use super::LogList;
use super::api::LogRecord;
use super::copy::LogsCopy;
use super::format::{first_of, format_duration, format_headers, js_string, pretty_json};
use crate::ui::settings::controls::raw_block;
use crate::ui::settings::state::Load;

/// The record as returned, with a copy action.
pub(super) fn json(record: &LogRecord, key: &str, copy: &'static LogsCopy) -> AnyElement {
    let text = pretty_json(record);
    Stack::new()
        .gap(Space::Xs)
        .child(raw_block(
            SharedString::from(format!("{key}-json")),
            copy.tabs[2],
            text.clone(),
            false,
            true,
        ))
        .child(
            Inline::new().justify(Justify::End).child(
                CopyButton::new(
                    SharedString::from(format!("{key}-copy-json")),
                    copy.copy_json,
                    copy.copied,
                )
                .text(text),
            ),
        )
        .into_any_element()
}

fn headers(value: Option<&Value>, key: &str, copy: &'static LogsCopy) -> Option<AnyElement> {
    let text = format_headers(value);
    (!text.is_empty()).then(|| {
        raw_block(
            SharedString::from(format!("{key}-headers")),
            copy.headers,
            text,
            true,
            false,
        )
    })
}

/// `String(value)` of a present value, shown when it is not empty.
fn shown(value: Option<&Value>) -> Option<String> {
    value.map(js_string).filter(|text| !text.is_empty())
}

impl LogList {
    pub(super) fn http_tabs(
        &self,
        record: &LogRecord,
        attrs: &Map<String, Value>,
        key: &str,
        copy: &'static LogsCopy,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // A finished exchange (it has a status) carries the response body; otherwise the request's.
        let on_response = attrs.contains_key("status");
        let mut request = Stack::new().gap(Space::Xs);
        if let Some(method) = attrs.get("method") {
            request = request.child(KeyValueRow::new(copy.method, js_string(method)));
        }
        if let Some(url) = shown(first_of(attrs, &["url", "route", "path"])) {
            request = request.child(KeyValueRow::new(copy.url, url));
        }
        let request_headers = first_of(attrs, &["request_headers", "headers"]);
        request = request.children(headers(request_headers, &format!("{key}-request"), copy));
        if !on_response {
            request = request.child(self.body(record, key, copy));
        }
        let mut response = Stack::new().gap(Space::Xs);
        if let Some(status) = attrs.get("status") {
            response = response.child(KeyValueRow::new(copy.status, js_string(status)));
        }
        if let Some(ms) = record.duration_ms {
            response = response.child(KeyValueRow::new(copy.duration, format_duration(ms)));
        }
        response = response.children(headers(
            attrs.get("response_headers"),
            &format!("{key}-response"),
            copy,
        ));
        if on_response {
            response = response.child(self.body(record, key, copy));
        }
        let body_tab = if on_response { "response" } else { "request" };
        let (view, reference) = (cx.entity(), record.body_ref.clone());
        let [request_label, response_label, json_label] = copy.tabs;
        Tabs::new(SharedString::from(format!("{key}-tabs")))
            .default_value("request")
            .list(TabsList::new("").variant(ListVariant::Line).triggers([
                Trigger::new("request", request_label),
                Trigger::new("response", response_label),
                Trigger::new("json", json_label),
            ]))
            .panel("request", request)
            .panel("response", response)
            .panel("json", json(record, key, copy))
            .on_value_change(move |tab, _, cx| {
                if tab == body_tab
                    && let Some(reference) = reference.clone()
                {
                    view.update(cx, |list, cx| list.ensure_body(reference, cx));
                }
            })
            .into_any_element()
    }

    /// The body: inline content, or the stored body fetched on demand, or why there is none.
    fn body(&self, record: &LogRecord, key: &str, copy: &'static LogsCopy) -> AnyElement {
        let id = SharedString::from(format!("{key}-body"));
        let note = |text: &'static str| Typo::caption(text).tone(Tone::Tertiary).into_any_element();
        if let Some(content) = &record.content {
            return raw_block(id, copy.body, pretty_json(content), false, false);
        }
        let Some(reference) = &record.body_ref else {
            return note(copy.body_unavailable);
        };
        match self.bodies.get(reference) {
            Some(Load::Failed) => note(copy.body_failed),
            Some(Load::Ready(text)) => raw_block(id, copy.body, readable(text), false, false),
            _ => raw_block(id, copy.body, "", false, false),
        }
    }
}

/// Stored bodies are JSON; show them indented when they parse.
fn readable(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .map_or_else(|_| body.to_owned(), |value| pretty_json(&value))
}
