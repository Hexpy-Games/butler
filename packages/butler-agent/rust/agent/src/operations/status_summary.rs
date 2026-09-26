//! Read-only, transient Operations projections for the public status commands.

mod context;
mod health;
mod operational;
mod stream;
mod tail;
mod usage;

use std::path::Path;

use serde_json::{Value, json};

use crate::models::NativeStatusModels;
use crate::models::{ModelCatalog, ModelConfiguration};
use std::sync::Arc;

pub(crate) async fn read_context_tool(
    data_root: &Path,
    session_id: &str,
    model_ref: &str,
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
) -> Value {
    context::read_context_for_session(data_root, session_id, model_ref, configuration, catalog)
        .await
}

pub(crate) fn read_usage_tool(data_root: &Path, session_id: &str, since_ts: Option<f64>) -> Value {
    let activity = health::read_transcript_activity(data_root);
    usage::read_usage(data_root, since_ts, Some(session_id), &activity)
}

pub(crate) fn read_usage_monitor(
    data_root: &Path,
    session_id: Option<&str>,
    since_ts: Option<f64>,
) -> Value {
    let activity = health::read_transcript_activity(data_root);
    usage::read_usage(
        data_root,
        since_ts,
        session_id.filter(|id| !id.trim().is_empty()),
        &activity,
    )
}

pub(crate) struct NativeMetricsStatus {
    pub(crate) value: Value,
    context_estimate: String,
}

pub(crate) fn read_prompt_cache_telemetry(data_root: &Path, since_ts: Option<f64>) -> Value {
    usage::prompt_cache_telemetry(data_root, since_ts)
}

pub(crate) fn tail_operational_metric_events(
    data_root: &Path,
    since_ts: Option<f64>,
    lines: usize,
) -> Vec<Value> {
    tail::tail_events(data_root, since_ts, lines)
}

impl NativeMetricsStatus {
    pub(crate) fn model_telemetry(&self) -> Value {
        self.value
            .pointer("/usage/model")
            .cloned()
            .unwrap_or_else(|| json!({}))
    }
}

pub(crate) async fn read_metrics_status(
    data_root: &Path,
    since_ts: Option<f64>,
    models: &NativeStatusModels,
    resources: &Path,
) -> NativeMetricsStatus {
    let enabled = operational::metrics_enabled(data_root);
    let operational = operational::read_summary(data_root, since_ts, enabled);
    let first_visible = operational::read_first_visible(data_root, since_ts);
    let transcript_activity = health::read_transcript_activity(data_root);
    let usage = usage::read_usage(data_root, since_ts, None, &transcript_activity);
    let context = context::read_context_monitor(data_root, models).await;
    let context_estimate = context::render_context_estimate(resources, data_root, models).await;
    let health = health::read_health(data_root, &transcript_activity);
    NativeMetricsStatus {
        value: json!({
            "enabled": enabled,
            "operational": operational,
            "firstVisibleLatency": first_visible,
            "usage": usage,
            "context": context,
            "health": health
        }),
        context_estimate,
    }
}

pub(crate) fn render_metrics_status(status: &NativeMetricsStatus) -> String {
    let value = &status.value;
    let operational = &value["operational"];
    let usage = &value["usage"];
    let context = &value["context"];
    let first_visible = &value["firstVisibleLatency"];
    let bucket = |category: &str, key: &str| {
        let item = &operational["byCategory"][category];
        item[key].as_u64().unwrap_or(0)
    };
    let latest = operational["latestEventTs"]
        .as_f64()
        .map(format_iso_utc)
        .unwrap_or_else(|| "none".into());
    let prompt = usage["model"]["promptTokens"].as_f64().unwrap_or(0.0);
    let cached = usage["model"]["cachedTokens"].as_f64().unwrap_or(0.0);
    let ratio = usage["model"]["cacheHitRatio"].as_f64().unwrap_or(0.0);
    let provider = usage["webSearch"]["lastProvider"]
        .as_str()
        .unwrap_or("none");
    let last_error = usage["webSearch"]["lastError"].as_str().unwrap_or("none");
    let threshold = context["pressure"]["thresholdState"]
        .as_str()
        .unwrap_or("unknown");
    let used_ratio = context["pressure"]["usedRatio"].as_f64().unwrap_or(0.0) * 100.0;
    let p50 = first_visible["p50Ms"]
        .as_f64()
        .map(format_number)
        .unwrap_or_else(|| "none".into());
    let p95 = first_visible["p95Ms"]
        .as_f64()
        .map(format_number)
        .unwrap_or_else(|| "none".into());
    format!(
        "Butler metrics\nenabled: {}\noperational events: {}\nparse errors: {}\nlatest event: {}\ningress: {} events, {} errors\nruntime: {} events, {} errors\ntools: {} events, {} errors\nfirst visible latency: events={}, p50={}ms, p95={}ms\nprompt cache: requests={}, cached={}, hitRatio={:.3}\nweb search: requests={}, provider={}, lastError={}\ncontext pressure: {}, usedRatio={:.1}%\nprivacy: rawTextStored=false",
        value["enabled"].as_bool().unwrap_or(false),
        operational["totalEvents"].as_u64().unwrap_or(0),
        operational["parseErrors"].as_u64().unwrap_or(0),
        latest,
        bucket("ingress", "events"),
        bucket("ingress", "errors"),
        bucket("runtime", "events"),
        bucket("runtime", "errors"),
        bucket("tool", "events"),
        bucket("tool", "errors"),
        first_visible["events"].as_u64().unwrap_or(0),
        p50,
        p95,
        usage["model"]["requestCount"].as_u64().unwrap_or(0),
        format_number(cached),
        if prompt == 0.0 { 0.0 } else { ratio },
        usage["webSearch"]["requestCount"].as_u64().unwrap_or(0),
        provider,
        last_error,
        threshold,
        used_ratio,
    )
}

pub(crate) fn render_status_context(
    metrics: &NativeMetricsStatus,
    models: &NativeStatusModels,
    services: &Value,
) -> String {
    let telemetry = metrics.model_telemetry();
    let runtime = format!(
        "## Runtime\nruntime: {}\nprovider: {}\nmodel: {}\nprompt cache policy: {}\nprompt cache telemetry: requests={}, cached={}, hitRatio={:.3}",
        models.runtime,
        models.provider,
        models.model_ref,
        models.cache_policy_text(Some("status-context")),
        telemetry["requestCount"].as_u64().unwrap_or(0),
        telemetry["cachedTokens"].as_f64().unwrap_or(0.0),
        telemetry["cacheHitRatio"].as_f64().unwrap_or(0.0),
    );
    let estimate = &metrics.context_estimate;
    let health = health::render_health(&metrics.value["health"]);
    let service_text = render_service_health(services);
    format!("{runtime}\n\n{estimate}\n\n{service_text}\n\n{health}")
}

fn render_service_health(services: &Value) -> String {
    let items = services["items"].as_array().cloned().unwrap_or_default();
    let mut lines = vec!["## Services".to_owned()];
    for item in items {
        let name = item["name"].as_str().unwrap_or("unknown");
        let status = item["status"].as_str().unwrap_or("unknown");
        let pid = item["pid"]
            .as_u64()
            .map(|pid| format!(" pid={pid}"))
            .unwrap_or_default();
        lines.push(format!("{name}: {status}{pid}"));
    }
    lines.push(format!(
        "summary: online={}, offline={}, stale={}",
        services["summary"]["online"].as_u64().unwrap_or(0),
        services["summary"]["offline"].as_u64().unwrap_or(0),
        services["summary"]["stale"].as_u64().unwrap_or(0)
    ));
    lines.join("\n")
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn format_iso_utc(timestamp_ms: f64) -> String {
    let seconds = crate::json::saturating_i64((timestamp_ms / 1_000.0).floor());
    let millis = crate::json::saturating_u32((timestamp_ms - seconds as f64 * 1_000.0).round());
    let timestamp = chrono::DateTime::from_timestamp(seconds, millis * 1_000_000);
    timestamp
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "none".into())
}
