//! Read-only, transient Operations projections for the public status commands.

mod context;
mod health;
mod operational;
mod stream;
mod tail;
mod usage;

use std::path::Path;

use serde_json::{Value, json};

use butler_models::models::{ModelCatalog, ModelConfiguration, StatusModels};
use std::sync::Arc;

pub async fn read_context_tool(
    data_root: &Path,
    session_id: &str,
    model_ref: &str,
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
) -> Value {
    context::read_context_for_session(data_root, session_id, model_ref, configuration, catalog)
        .await
}

pub use usage::{UsageMonitor, UsageMonitorSources};

/// The `read_usage` tool: one runtime session's usage.
pub async fn read_usage_tool(
    data_root: &Path,
    session_id: &str,
    since_ts: Option<f64>,
    lineage: Arc<crate::operations::UsageLineage>,
    catalog: Arc<ModelCatalog>,
) -> Value {
    let read = lineage.read.clone().lock_owned().await;
    let root = data_root.to_path_buf();
    let monitor = lineage.monitor.clone();
    let refresh = (root.clone(), monitor.clone(), catalog.clone());
    if let Err(error) = tokio::task::spawn_blocking(move || {
        refresh
            .1
            .refresh_owners(&refresh.0, &|model| refresh.2.pricing(model));
    })
    .await
    {
        return usage_tool_error(&error);
    }
    lineage.resolve().await;
    let session = session_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let pricing = |model: &str| catalog.pricing(model);
        let sources = UsageMonitorSources {
            chatgpt_account: None,
            pricing: &pricing,
            quota: &crate::operations::unavailable_quota_view,
            quota_providers: Vec::new(),
        };
        monitor.read_prepared_at_releasing(
            &root,
            Some(&session),
            None,
            since_ts,
            (chrono::Utc::now().timestamp_millis() + 1) as f64,
            Some(&sources),
            read,
        )
    })
    .await
    .unwrap_or_else(|error| usage_tool_error(&error))
}

fn usage_tool_error(error: &tokio::task::JoinError) -> Value {
    json!({"ok": false, "error": {
        "code": "usage_monitor_failed",
        "message": format!("Could not read usage: {error}")
    }})
}

pub struct MetricsStatus {
    pub value: Value,
    context_estimate: String,
}

pub fn read_prompt_cache_telemetry(data_root: &Path, since_ts: Option<f64>) -> Value {
    usage::prompt_cache_telemetry(data_root, since_ts)
}

pub fn tail_operational_metric_events(
    data_root: &Path,
    since_ts: Option<f64>,
    lines: usize,
) -> Vec<Value> {
    tail::tail_events(data_root, since_ts, lines)
}

impl MetricsStatus {
    pub fn model_telemetry(&self) -> Value {
        self.value
            .pointer("/usage/model")
            .cloned()
            .unwrap_or_else(|| json!({}))
    }
}

pub async fn read_metrics_status(
    data_root: &Path,
    since_ts: Option<f64>,
    models: &StatusModels,
    resources: &Path,
    memory_paths: &[std::path::PathBuf],
) -> MetricsStatus {
    let enabled = operational::metrics_enabled(data_root);
    let operational = operational::read_summary(data_root, since_ts, enabled);
    let first_visible = operational::read_first_visible(data_root, since_ts);
    let monitor = UsageMonitor::default();
    let transcript_activity = monitor.transcript_activity(data_root);
    let usage = monitor.read(data_root, None, since_ts, None);
    let context = context::read_context_monitor(data_root, models).await;
    let context_estimate =
        context::render_context_estimate(resources, data_root, models, memory_paths).await;
    let health = health::read_health(data_root, &transcript_activity);
    MetricsStatus {
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

pub fn render_metrics_status(status: &MetricsStatus) -> String {
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

pub fn render_status_context(
    metrics: &MetricsStatus,
    models: &StatusModels,
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
    let seconds = butler_core::json::saturating_i64((timestamp_ms / 1_000.0).floor());
    let millis =
        butler_core::json::saturating_u32((timestamp_ms - seconds as f64 * 1_000.0).round());
    let timestamp = chrono::DateTime::from_timestamp(seconds, millis * 1_000_000);
    timestamp
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "none".into())
}
