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
    let Some(log) = butler_log::global().filter(|log| log.enabled("http.server", level)) else {
        return;
    };
    let route = if admitted {
        route.map(MatchedPath::as_str).unwrap_or("<unmatched>")
    } else {
        "<unmatched>"
    };
    let mut row = butler_log::Record::new(level, "http.server", "http.request", "Gateway request");
    row.duration_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
    row.attrs =
        serde_json::json!({"method":method.as_str(),"route":route,"status":status.as_u16()});
    let _ = log.record_written(row).await;
}
