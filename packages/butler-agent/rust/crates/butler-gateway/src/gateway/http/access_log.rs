//! Access records never include query strings or request payloads.
use axum::http::{Method, StatusCode};
use std::time::Instant;

pub(super) fn finish(method: &Method, route: &str, status: StatusCode, start: Instant) {
    let level = if status.is_server_error() {
        "ERROR"
    } else if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        "DEBUG"
    } else {
        "INFO"
    };
    let Some(log) = butler_log::global().filter(|log| log.enabled("http.server", level)) else {
        return;
    };
    let mut row = butler_log::Record::new(level, "http.server", "http.request", "Gateway request");
    row.duration_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
    row.attrs = serde_json::json!({"method":method.as_str(),"route":template(route),"status":status.as_u16()});
    let _ = log.record(row);
}
pub(super) fn template(path: &str) -> String {
    let mut previous = "";
    path.split('/')
        .map(|segment| {
            let value = if matches!(
                previous,
                "sessions"
                    | "projects"
                    | "messages"
                    | "turns"
                    | "worker-activity"
                    | "bodies"
                    | "task-graphs"
                    | "subsessions"
                    | "authority-requests"
            ) && !segment.is_empty()
            {
                ":id"
            } else {
                segment
            };
            previous = segment;
            value
        })
        .collect::<Vec<_>>()
        .join("/")
}
