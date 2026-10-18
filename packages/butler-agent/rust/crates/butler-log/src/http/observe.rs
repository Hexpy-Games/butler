use super::{Phase, Purpose};
use crate::{Preset, Record};
use bytes::Bytes;
use futures_core::Stream;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    pin::Pin,
    task::{Context, Poll},
    time::Instant,
};

pub(super) fn detailed() -> bool {
    crate::global().is_some_and(|log| log.config().effective.level.threshold() >= 4)
}
pub(super) fn full() -> bool {
    crate::global().is_some_and(|log| log.config().effective.level == Preset::Full)
}
pub(super) struct Attempt {
    pub row: Record,
    start: Instant,
    bytes: u64,
    chunks: u64,
    upload: std::sync::Arc<super::upload::Capture>,
    request_headers: reqwest::header::HeaderMap,
    response: Vec<u8>,
    error_body: Vec<u8>,
    capture: bool,
    failed: bool,
    sse: bool,
    line: Vec<u8>,
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
        let capture = full();
        let upload = super::upload::Capture::attach(request);
        Self {
            row,
            start: Instant::now(),
            bytes: 0,
            chunks: 0,
            upload,
            request_headers: request.headers().clone(),
            response: Vec::new(),
            error_body: Vec::new(),
            capture,
            failed: false,
            sse: false,
            line: Vec::new(),
        }
    }
    pub(super) fn headers(&mut self, response: &reqwest::Response) {
        self.row.attrs["status"] = json!(response.status().as_u16());
        self.row.attrs["response_headers"] = headers(response.headers());
        self.row.attrs["first_byte_ms"] = json!(self.start.elapsed().as_secs_f64() * 1000.0);
        self.failed = response.status().is_client_error() || response.status().is_server_error();
        if self.failed {
            self.row.level = "ERROR".into();
        }
        self.sse = response
            .headers()
            .get("content-type")
            .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"));
    }
    pub(super) fn wrap(self, response: reqwest::Response) -> reqwest::Response {
        let (parts, body) = super::response::split(response);
        let stream = Observed {
            inner: Box::pin(body.into_data_stream()),
            attempt: Some(self),
        };
        ::http::Response::from_parts(parts, reqwest::Body::wrap_stream(stream)).into()
    }
    fn chunk(&mut self, bytes: &[u8]) {
        self.bytes += bytes.len() as u64;
        self.chunks += 1;
        if self.failed && detailed() {
            let remaining = 4096 - self.error_body.len();
            self.error_body
                .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        }
        if self.capture && full() {
            self.response.extend_from_slice(bytes);
        }
        if self.sse && crate::global().is_some_and(|log| log.enabled(&self.row.category, "TRACE")) {
            self.events(bytes);
        }
    }
    fn events(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\n' {
                let line = String::from_utf8_lossy(&self.line);
                let event = line
                    .strip_prefix("event:")
                    .map(str::trim)
                    .map(str::to_owned)
                    .or_else(|| {
                        line.strip_prefix("data:")
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            .and_then(|v| v["type"].as_str().map(str::to_owned))
                    })
                    .or_else(|| line.starts_with("data:").then(|| "message".to_owned()));
                if let Some(event) = event {
                    let mut row = self.row.clone();
                    row.level = "TRACE".into();
                    row.event = "http.stream.event".into();
                    row.attrs = json!({"type":event});
                    crate::emit(row);
                }
                self.line.clear();
            } else if self.line.len() < 8192 {
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
        if self.failed && detailed() {
            self.row.error = Some(json!({"body":error_text(&self.error_body)}));
        }
        if self.capture && full() {
            self.row.content = Some(
                json!({"request":self.upload.body(&self.request_headers),"response":decode(&self.response)}),
            );
        }
        crate::emit(self.row.clone());
    }
}
struct Observed {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    attempt: Option<Attempt>,
}
impl Stream for Observed {
    type Item = Result<Bytes, reqwest::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = self.inner.as_mut().poll_next(cx);
        match &next {
            Poll::Ready(Some(Ok(bytes))) => {
                if let Some(attempt) = &mut self.attempt {
                    attempt.chunk(bytes);
                }
            }
            Poll::Ready(Some(Err(error))) => {
                if let Some(attempt) = &mut self.attempt {
                    attempt.row.level = "ERROR".into();
                    attempt.row.error = Some(json!({"message":error.to_string()}));
                }
                self.attempt.take();
            }
            Poll::Ready(None) => {
                if let Some(attempt) = &mut self.attempt {
                    attempt.row.attrs["response_complete"] = json!(true);
                }
                self.attempt.take();
            }
            Poll::Pending => {}
        }
        next
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
