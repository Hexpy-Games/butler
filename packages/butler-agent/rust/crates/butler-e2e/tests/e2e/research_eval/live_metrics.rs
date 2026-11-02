use super::live_proxy::Traffic;
use axum::{Json, extract::State};
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub(super) async fn host_events(
    State(traffic): State<Arc<Mutex<Traffic>>>,
    Json(event): Json<Value>,
) -> http::StatusCode {
    let mut traffic = traffic.lock().unwrap();
    if let Some(error) = event["host_error"].as_str() {
        traffic.host_errors.push(error.to_owned());
    }
    traffic.host_ready |= event["ready"] == true;
    traffic.snapshot_reads += usize::from(event["snapshot_read"] == true);
    traffic.host_reader_replies += usize::from(event["reader_reply"] == true);
    traffic.unknown_host_ops += usize::from(event["unknown"] == true);
    if let Some(op) = event["op"].as_str() {
        *traffic.host_ops.entry(op.to_owned()).or_default() += 1;
    }
    if let Some(host) = event["refused_host"].as_str() {
        traffic.refused_hosts.push(host.to_owned());
    }
    if let Some(url) = event["offline_miss"].as_str() {
        traffic.offline_misses.push(url.to_owned());
    }
    traffic.changed.notify_one();
    http::StatusCode::NO_CONTENT
}
