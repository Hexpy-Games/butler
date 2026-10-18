//! Access records contain admitted router templates, never request paths.
use axum::{
    extract::MatchedPath,
    http::{Method, StatusCode},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

#[derive(Clone, Default)]
pub(super) struct Admission(Arc<AtomicBool>);
impl Admission {
    pub(super) fn is_granted(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
    pub(super) fn grant(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
pub(super) async fn finish(
    method: &Method,
    route: Option<&MatchedPath>,
    admitted: &Admission,
    status: StatusCode,
    start: Instant,
) {
    let admitted = admitted.0.load(Ordering::Relaxed);
    let level = if !admitted || route.is_none() || status.is_client_error() {
        "DEBUG"
    } else if status.is_server_error() {
        "ERROR"
    } else if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        "DEBUG"
    } else {
        "INFO"
    };
    let route = if admitted {
        route.map(MatchedPath::as_str).unwrap_or("<unmatched>")
    } else {
        "<unmatched>"
    };
    tracing::Span::current()
        .record("log_level", level)
        .record("method", method.as_str())
        .record("route", route)
        .record("status", status.as_u16());
    let Some(log) = butler_log::global().filter(|log| log.enabled("http.server", level)) else {
        return;
    };
    let mut row = butler_log::Record::new(level, "http.server", "http.request", "Gateway request");
    let context = butler_log::TraceContext::current();
    row.trace_id = context.trace_id;
    row.span_id = context.span_id;
    let elapsed = start.elapsed();
    row.duration_ms = Some(elapsed.as_secs_f64() * 1000.0);
    let started_at = chrono::Utc::now() - chrono::Duration::from_std(elapsed).unwrap_or_default();
    row.attrs = serde_json::json!({"method":method.as_str(),"route":route,"status":status.as_u16(),"start":started_at.to_rfc3339_opts(chrono::SecondsFormat::Micros,true)});
    let _ = log.record_written(row).await;
}
