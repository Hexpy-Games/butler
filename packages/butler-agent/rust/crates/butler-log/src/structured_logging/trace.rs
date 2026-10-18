//! Span lifetimes and bounded projections over the existing bloom-filter index.
use super::{Logger, Query, Record};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    io,
    time::Instant,
};

pub(super) struct Lifetime {
    row: Record,
    started: Instant,
}
impl Lifetime {
    pub(super) fn new(metadata: &tracing::Metadata<'_>, fields: &Map<String, Value>) -> Self {
        let name = fields
            .get("span_name")
            .and_then(Value::as_str)
            .unwrap_or(metadata.name());
        let category = if name == "http.server" {
            name
        } else {
            name.split('.').next().unwrap_or("agent")
        };
        let level = fields
            .get("log_level")
            .and_then(Value::as_str)
            .unwrap_or(metadata.level().as_str());
        let row = Record::new(level, category, "span.start", name);
        Self {
            row: with_fields(row, fields),
            started: Instant::now(),
        }
    }
    pub(super) fn start(&self, log: &Logger) {
        let _ = log.record(self.row.clone());
    }
    pub(super) fn finish(&self, log: &Logger, fields: &Map<String, Value>) {
        let mut row = with_fields(self.row.clone(), fields);
        row.event = "span.end".into();
        if let Some(start) = fields.get("started_at").and_then(Value::as_str) {
            row.ts = start.into();
        }
        row.attrs["started_at"] = row.ts.clone().into();
        row.ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        row.duration_ms = Some(
            if fields.get("started_at").and_then(Value::as_str).is_some() {
                (millis(&row.ts) - millis(row.attrs["started_at"].as_str().unwrap_or(&row.ts)))
                    .max(0.0)
            } else {
                self.started.elapsed().as_secs_f64() * 1000.0
            },
        );
        if row.attrs["status"] == "error" {
            row.level = "ERROR".into();
        }
        let _ = log.record(row);
    }
}
fn with_fields(mut row: Record, fields: &Map<String, Value>) -> Record {
    let string = |key: &str| fields.get(key).and_then(Value::as_str).map(str::to_owned);
    if let Some(level) = string("log_level") {
        row.level = level;
    }
    row.trace_id = string("trace_id");
    row.span_id = string("span_id");
    row.parent_span_id = string("parent_span_id");
    row.chat_id = string("chat_id");
    row.turn_id = string("turn_id");
    row.error = fields.get("failure").cloned();
    row.attrs = Value::Object(fields.clone());
    row
}

#[derive(Serialize)]
pub struct Trace {
    pub trace_id: String,
    pub started_at: Option<String>,
    pub duration_ms: f64,
    pub outcome: String,
    pub model: Option<String>,
    pub chat_id: Option<String>,
    pub turn_id: Option<String>,
    pub spans: Vec<TraceSpan>,
    pub truncated: bool,
    pub scanned_bytes: u64,
}
#[derive(Serialize)]
pub struct TraceSpan {
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub category: String,
    pub process: String,
    pub start_offset_ms: f64,
    pub duration_ms: Option<f64>,
    pub status: String,
    pub tone: String,
    pub title: String,
    pub child_count: usize,
    pub has_details: bool,
    pub attrs: Value,
}
impl Logger {
    pub fn trace(&self, trace_id: &str) -> io::Result<Trace> {
        if !valid_id(trace_id, 32) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid trace id",
            ));
        }
        let (rows, scanned_bytes, truncated) = self.trace_rows(Query {
            trace_id: Some(trace_id.into()),
            ..Query::default()
        })?;
        Ok(project(trace_id, rows, scanned_bytes, truncated))
    }
    /// Resolve the latest trace; a restarted turn can also be queried through /logs?turn_id=.
    pub fn resolve_trace(
        &self,
        turn_id: Option<String>,
        chat_id: Option<String>,
        message_id: Option<&str>,
    ) -> io::Result<Trace> {
        if turn_id.is_none() && (chat_id.is_none() || message_id.is_none()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "turn_id or chat_id and message_id required",
            ));
        }
        let page = self.query_trace(&Query {
            turn_id,
            chat_id,
            message_id: message_id.map(str::to_owned),
            limit: 1,
            ..Query::default()
        })?;
        let id = page
            .rows
            .iter()
            .find(|r| {
                message_id.is_none_or(|id| r.attrs["message_id"].as_str() == Some(id))
                    && r.trace_id.is_some()
            })
            .and_then(|r| r.trace_id.as_deref())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "trace not found"))?;
        let mut trace = self.trace(id)?;
        trace.scanned_bytes += page.scanned_bytes;
        Ok(trace)
    }
    fn trace_rows(&self, mut query: Query) -> io::Result<(Vec<Record>, u64, bool)> {
        query.limit = 10000;
        let page = self.query_trace(&query)?;
        Ok((page.rows, page.scanned_bytes, !page.exhausted))
    }
}

pub(crate) fn valid_id(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}
fn millis(ts: &str) -> f64 {
    chrono::DateTime::parse_from_rfc3339(ts).map_or(0.0, |v| v.timestamp_micros() as f64 / 1000.0)
}
fn project(id: &str, mut rows: Vec<Record>, scanned_bytes: u64, truncated: bool) -> Trace {
    rows.sort_by(|a, b| a.ts.cmp(&b.ts));
    let details: HashSet<_> = rows
        .iter()
        .filter(|r| r.content.is_some() || r.body_ref.is_some() || r.error.is_some())
        .filter_map(|r| r.span_id.clone())
        .collect();
    let spans = completed_spans(&rows);
    let start = spans.first().map_or(0.0, |r| millis(&r.ts));
    let mut trace = Trace {
        trace_id: id.into(),
        started_at: spans.first().map(|r| r.ts.clone()),
        duration_ms: 0.0,
        outcome: "ok".into(),
        model: None,
        chat_id: None,
        turn_id: None,
        spans: Vec::new(),
        truncated,
        scanned_bytes,
    };
    let mut remaining = spans;
    let mut seen = HashSet::new();
    let all: HashSet<String> = remaining.iter().filter_map(|r| r.span_id.clone()).collect();
    while !remaining.is_empty() {
        let index = remaining
            .iter()
            .position(|r| {
                r.parent_span_id
                    .as_ref()
                    .is_none_or(|p| seen.contains(p) || !all.contains(p))
            })
            .unwrap_or(0);
        let row = remaining.remove(index);
        seen.insert(row.span_id.clone().unwrap_or_default());
        trace.chat_id = trace.chat_id.or(row.chat_id.clone());
        trace.turn_id = trace.turn_id.or(row.turn_id.clone());
        if row.turn_id == trace.turn_id {
            trace.model = row.attrs["model"]
                .as_str()
                .map(str::to_owned)
                .or(trace.model);
        }
        let mut span = span(row, start);
        span.has_details |= details.contains(&span.span_id);
        trace.duration_ms = trace
            .duration_ms
            .max(span.start_offset_ms + span.duration_ms.unwrap_or(0.0));
        if span.status == "error"
            && matches!(span.category.as_str(), "turn" | "schedule" | "http.server")
        {
            trace.outcome = "error".into();
        }
        trace.spans.push(span);
    }
    let mut counts = HashMap::new();
    for span in &trace.spans {
        if let Some(parent) = &span.parent_span_id {
            *counts.entry(parent.clone()).or_insert(0) += 1;
        }
    }
    for span in &mut trace.spans {
        span.child_count = counts.get(&span.span_id).copied().unwrap_or(0);
    }
    trace
}
fn completed_spans(rows: &[Record]) -> Vec<Record> {
    let mut unique = HashMap::new();
    let mut access = Vec::new();
    for row in rows {
        if row.category == "http.server" && row.event == "http.request" {
            access.push(row);
            continue;
        }
        if matches!(
            row.event.as_str(),
            "span.start" | "span.end" | "http.request"
        ) && let Some(id) = &row.span_id
        {
            unique.insert(id.clone(), row.clone());
        }
    }
    for detail in access {
        let Some(id) = detail.span_id.as_ref() else {
            continue;
        };
        let id = if unique.contains_key(id) {
            id
        } else {
            detail
                .parent_span_id
                .as_ref()
                .filter(|parent| unique.contains_key(*parent))
                .unwrap_or(id)
        };
        let row = unique.entry(id.clone()).or_insert_with(|| {
            let mut row = detail.clone();
            row.event = "span.end".into();
            row.msg = "http.server".into();
            row
        });
        if let (Some(attrs), Some(extra)) = (row.attrs.as_object_mut(), detail.attrs.as_object()) {
            attrs.extend(extra.clone());
        }
        row.attrs["access_log"] = true.into();
        if let Some(body_ref) = &detail.body_ref {
            row.attrs["body_ref"] = body_ref.clone().into();
        }
    }
    let mut spans: Vec<Record> = unique
        .into_values()
        .map(|mut row| {
            if let Some(start) = row.attrs["started_at"]
                .as_str()
                .or_else(|| row.attrs["start"].as_str())
            {
                row.ts = start.into();
            }
            row
        })
        .collect();
    spans.sort_by(|a, b| a.ts.cmp(&b.ts));
    spans
}

fn span(row: Record, start: f64) -> TraceSpan {
    let error = row.attrs["status"]
        .as_u64()
        .is_some_and(|status| status >= 400)
        || row.level == "ERROR"
        || row.error.is_some()
        || row.attrs["status"] == "error";
    let status = if error {
        "error"
    } else if row.msg == "retry.wait" {
        "wait"
    } else if row.level == "WARN" {
        "warn"
    } else {
        "ok"
    };
    let tone = if error {
        "error"
    } else if matches!(status, "wait" | "warn") {
        "wait"
    } else if row.category == "http.server" {
        "app"
    } else if row.event == "http.request"
        || matches!(row.category.as_str(), "model" | "http" | "stream")
    {
        "model"
    } else if matches!(row.category.as_str(), "tool" | "mcp") {
        "tool"
    } else if row.process.starts_with("app") {
        "app"
    } else {
        "agent"
    };
    TraceSpan {
        span_id: row.span_id.unwrap_or_default(),
        parent_span_id: row.parent_span_id,
        name: if row.event == "http.request" {
            row.event
        } else {
            row.msg.clone()
        },
        category: row.category,
        process: row.process,
        start_offset_ms: (millis(&row.ts) - start).max(0.0),
        duration_ms: row.duration_ms,
        status: status.into(),
        tone: tone.into(),
        title: row.msg,
        child_count: 0,
        has_details: row.content.is_some()
            || row.error.is_some()
            || row.body_ref.is_some()
            || row.attrs["access_log"] == true,
        attrs: row.attrs,
    }
}
