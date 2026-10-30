use super::{Phase, Purpose};
use crate::{Preset, Record};
use serde_json::{Value, json};
use std::time::Instant;

pub(super) fn detailed() -> bool {
    crate::global().is_some_and(|log| log.config().effective.level.threshold() >= 4)
}
pub(super) fn full() -> bool {
    crate::global().is_some_and(|log| log.config().effective.level == Preset::Full)
}
pub(super) struct Attempt {
    pub row: Record,
    start: Instant,
    pub(super) bytes: u64,
    pub(super) chunks: u64,
    upload: std::sync::Arc<super::upload::Capture>,
    request_headers: reqwest::header::HeaderMap,
    response: super::capture::Capture,
    error_body: Vec<u8>,
    phase: Phase,
    capture: bool,
    failed: bool,
    pub(super) sse: bool,
    line: super::sse::Line,
    receive: Option<(Instant, String)>,
}
impl Attempt {
    pub(super) fn new(request: &mut reqwest::Request, purpose: &Purpose, phase: &Phase) -> Self {
        let mut row = Record::new("DEBUG", &purpose.category, "http.request", "HTTP request");
        crate::structured_logging::current_ids(&mut row);
        if let Some(id) = &phase.trace_id {
            row.trace_id = Some(id.clone());
        }
        if let Some(id) = &phase.turn_id {
            row.turn_id = Some(id.clone());
        }
        if let Some(id) = &phase.chat_id {
            row.chat_id = Some(id.clone());
        }
        row.parent_span_id = row.span_id.take();
        row.span_id = Some(uuid::Uuid::new_v4().simple().to_string()[..16].into());
        let url = crate::redact_url(request.url().as_str());
        let path = url::Url::parse(&url).ok().map(|url| {
            let mut path = url.path().to_owned();
            if let Some(query) = url.query() {
                path.push('?');
                path.push_str(query);
            }
            path
        });
        let body = request.body().and_then(reqwest::Body::as_bytes);
        row.attrs = json!({
            "method":request.method().as_str(), "host":request.url().host_str(), "port":request.url().port_or_known_default(),
            "path":path, "request_headers":headers(request.headers()),
            "request_bytes":body.map(<[u8]>::len), "purpose":purpose.name,
            "phase":phase.name, "retry":phase.retry, "start":row.ts,
        });
        let upload = super::upload::Capture::attach(request, phase.sensitive);
        Self {
            row,
            start: Instant::now(),
            bytes: 0,
            chunks: 0,
            upload,
            request_headers: request.headers().clone(),
            response: super::capture::Capture::new(request.headers()),
            error_body: Vec::new(),
            phase: phase.clone(),
            capture: full() && !phase.sensitive,
            failed: false,
            sse: false,
            line: super::sse::Line::default(),
            receive: None,
        }
    }
    pub(super) fn headers(&mut self, response: &reqwest::Response) {
        self.row.attrs["status"] = json!(response.status().as_u16());
        self.row.attrs["response_headers"] = headers(response.headers());
        self.row.attrs["first_byte_ms"] = json!(self.start.elapsed().as_secs_f64() * 1000.0);
        self.failed = response.status().is_client_error() || response.status().is_server_error();
        if self.failed && !self.phase.routine {
            self.row.level = "ERROR".into();
        }
        self.response = super::capture::Capture::new(response.headers());
        self.sse = response
            .headers()
            .get("content-type")
            .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"));
    }
    pub(super) fn wrap(self, response: reqwest::Response) -> reqwest::Response {
        let (parts, body) = super::response::split(response);
        let stream = super::body::Observed {
            inner: body,
            attempt: Some(self),
        };
        ::http::Response::from_parts(parts, reqwest::Body::wrap(stream)).into()
    }
    pub(super) fn chunk(&mut self, bytes: &[u8]) {
        if self.receive.is_none() {
            self.receive = Some((
                Instant::now(),
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            ));
        }
        self.bytes += bytes.len() as u64;
        self.chunks += 1;
        if self.failed && !self.phase.sensitive && detailed() && self.response.is_text() {
            let remaining = 4096 - self.error_body.len();
            self.error_body
                .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        }
        if self.capture && full() {
            self.response.observe(bytes);
        }
        if self.sse
            && !self.phase.sensitive
            && crate::global().is_some_and(|log| log.enabled(&self.row.category, "DEBUG"))
        {
            self.events(bytes);
        }
    }
    pub(super) fn read_error(&mut self, error: &reqwest::Error) {
        self.row.level = if self.phase.routine { "DEBUG" } else { "ERROR" }.into();
        self.row.error = Some(json!({"message":error.to_string()}));
    }
    pub(super) fn complete(&mut self) {
        self.row.attrs["response_complete"] = json!(true);
    }
    fn events(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\n' {
                let (event, reason) = self.line.finish();
                if let Some(reason) = reason {
                    self.row.attrs["finish_reason"] = reason.into();
                }
                if let Some(event) = event.filter(|_| {
                    crate::global().is_some_and(|log| log.enabled(&self.row.category, "TRACE"))
                }) {
                    let mut row = self.row.clone();
                    row.level = "TRACE".into();
                    row.event = "http.stream.event".into();
                    row.attrs = json!({"type":event});
                    crate::emit(row);
                }
            } else {
                self.line.push(byte);
            }
        }
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        self.row.duration_ms = Some(self.start.elapsed().as_secs_f64() * 1000.0);
        self.row.attrs["total_ms"] = json!(self.row.duration_ms);
        self.row.attrs["request_bytes"] = json!(self.upload.bytes());
        self.row.attrs["response_bytes"] = json!(self.bytes);
        self.row.attrs["chunks"] = json!(self.chunks);
        if self.row.attrs.get("response_complete").is_none() {
            self.row.attrs["response_complete"] = json!(false);
        }
        if self.sse
            && let Some((started, ts)) = &self.receive
        {
            let mut stream = self.row.clone();
            stream.parent_span_id = stream.span_id.take();
            stream.span_id = Some(uuid::Uuid::new_v4().simple().to_string()[..16].into());
            stream.event = "span.end".into();
            stream.msg = "stream.receive".into();
            stream.category = "stream".into();
            stream.attrs["started_at"] = ts.clone().into();
            stream.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
            stream.ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
            crate::emit(stream);
        }
        let mut row = self.row.clone();
        let error_body = std::mem::take(&mut self.error_body);
        let response = std::mem::take(&mut self.response);
        let upload = self.upload.clone();
        let headers = std::mem::take(&mut self.request_headers);
        let failed = self.failed && !self.phase.sensitive && detailed();
        let capture = self.capture && full();
        if let Some(log) = crate::global() {
            let retained = response.retained_bytes() + upload.retained_bytes() + 16384;
            log.record_deferred(
                &row.category.clone(),
                &row.level.clone(),
                retained,
                move || {
                    if failed && row.error.is_none() {
                        row.error = Some(json!({"body":error_text(&error_body)}));
                    }
                    if capture {
                        row.content = Some(
                            json!({"request":upload.body(&headers),"response":response.content()}),
                        );
                    }
                    row
                },
            );
        }
    }
}
fn headers(headers: &reqwest::header::HeaderMap) -> Value {
    crate::redact_headers(
        headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.to_str().unwrap_or_default())),
    )
}
pub(super) fn content(bytes: &[u8], headers: &reqwest::header::HeaderMap) -> Value {
    if headers.get("content-type").is_some_and(|v| {
        v.as_bytes()
            .starts_with(b"application/x-www-form-urlencoded")
    }) {
        let pairs: serde_json::Map<String, Value> = url::form_urlencoded::parse(bytes)
            .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
            .collect();
        Value::Object(pairs)
    } else {
        decode(bytes)
    }
}
fn decode(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|_| match std::str::from_utf8(bytes) {
        Ok(text) => json!(text),
        Err(_) => {
            use base64::Engine;
            json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)})
        }
    })
}

fn error_text(bytes: &[u8]) -> String {
    let mut text = crate::redact_log_line(&String::from_utf8_lossy(bytes));
    let mut end = text.len().min(4096);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}
