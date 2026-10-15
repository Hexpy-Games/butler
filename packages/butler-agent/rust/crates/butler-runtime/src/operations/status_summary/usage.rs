//! Prompt-cache and web-search telemetry projections, streamed from DATA logs.

mod availability;
mod buckets;
mod log;
mod row;
mod web;

use std::{collections::BTreeMap, path::Path};

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::health::{self, TranscriptActivityProjection};
use super::stream::{number, visit_jsonl};

use crate::context::TranscriptActivityCache;
use buckets::Tokens;
use log::{UsageLogIndex, Window};
use row::{Names, UsageRow};

const MAP_LIMIT: usize = 512;
const PROVIDER_LIMIT: usize = 64;

/// Catalog prices and provider quota for the usage monitor's cost and
/// remaining-quota fields. Without them both report "unavailable".
pub struct UsageMonitorSources<'a> {
    /// The catalog list price of a model ref.
    pub pricing: &'a dyn Fn(&str) -> Option<butler_models::models::ModelPricing>,
    /// The latest quota view of a provider id.
    pub quota: &'a dyn Fn(&str) -> crate::operations::ProviderQuotaView,
    /// Providers that reported quota, shown even without usage in the window.
    pub quota_providers: Vec<String>,
}

/// The usage monitor with what it keeps between reads: the parsed prompt-usage
/// log and the activity of each transcript. A read parses only what grew
/// since the last one, so a long-lived monitor answers in milliseconds.
#[derive(Default)]
pub struct UsageMonitor {
    log: Mutex<UsageLogIndex>,
    searches: Mutex<web::SearchIndex>,
    transcripts: Mutex<TranscriptActivityCache>,
}

impl UsageMonitor {
    /// Windowed usage turn provenance for the returned sessions. The App owner
    /// resolves these against indexed schedule bindings, independently of dispatch time.
    pub fn session_turns(
        &self,
        view: &Value,
    ) -> std::collections::HashMap<String, std::collections::HashSet<String>> {
        self.log.lock().session_turns(view)
    }

    /// The usage view of `session_id` (a runtime session id; all sessions
    /// when `None`) since `since_ts`. Transcripts are read only for the
    /// selected view; every file scan resumes from its last complete line.
    pub fn read(
        &self,
        data_root: &Path,
        session_id: Option<&str>,
        since_ts: Option<f64>,
        sources: Option<&UsageMonitorSources<'_>>,
    ) -> Value {
        self.read_at(
            data_root,
            session_id,
            None,
            since_ts,
            (chrono::Utc::now().timestamp_millis() + 1) as f64,
            sources,
        )
    }

    /// The same projection with one captured upper bound for both periods.
    pub fn read_at(
        &self,
        data_root: &Path,
        session_id: Option<&str>,
        usage_scope: Option<&str>,
        since_ts: Option<f64>,
        now: f64,
        sources: Option<&UsageMonitorSources<'_>>,
    ) -> Value {
        let session_id = session_id.filter(|id| !id.trim().is_empty());
        let pricing = sources.map(|sources| sources.pricing);
        let (buckets, timeline, top_sessions, previous, scope) = {
            let mut log = self.log.lock();
            log.refresh(data_root, pricing);
            let scope = log.resolve_scope(session_id, usage_scope);
            let window = Window {
                scope: scope.as_deref(),
                since_ts,
                until_ts: since_ts.map(|_| now),
            };
            let previous = since_ts.map(|since| {
                log.tokens(Window {
                    since_ts: Some(since - (now - since)),
                    until_ts: Some(since),
                    ..window
                })
                .total
            });
            (
                log.buckets(window, pricing),
                log.timeline(window),
                if since_ts.is_some() {
                    log.top_sessions(window)
                } else {
                    json!([])
                },
                previous,
                scope,
            )
        };
        let cost = buckets.cost_value();
        let (model_value, provider_buckets) = buckets.views();
        let web_search = availability::read_web_search(data_root, since_ts, now, self);
        let providers = provider_summary(provider_buckets, sources);
        let tool_session = scope
            .as_deref()
            .map(|scope| scope.strip_prefix("btcc-guided:").unwrap_or(scope));
        let (tools, transcript_activity_status, tools_availability) =
            availability::read_tools(data_root, tool_session, since_ts, now, self);
        json!({
            "filters": { "sessionId": session_id, "sinceTs": since_ts, "untilTs": since_ts.map(|_| now) },
            "model": model_value,
            "timeline": timeline,
            "topSessions": top_sessions,
            "previousPeriod": previous.map(|total| json!({"totalTokens":total})),
            "webSearch": web_search,
            "tools": tools,
            "providerUsage": providers,
            "cost": cost,
            "privacy": {
                "rawTextStored": false,
                "rawToolArgumentsIncluded": false,
                "rawToolResultsIncluded": false
            },
            "availability": {
                "transcriptActivity": transcript_activity_status,
                "tools": tools_availability
            }
        })
    }

    /// The activity of every transcript, scanning what changed.
    pub(super) fn transcript_activity(&self, data_root: &Path) -> TranscriptActivityProjection {
        health::activity_projection(self.transcripts.lock().read_now(data_root))
    }

    /// One transcript file's tool usage, scanning what grew.
    pub(super) fn file_activity(
        &self,
        path: &Path,
    ) -> Option<crate::context::StatusTranscriptActivity> {
        self.transcripts.lock().read_file(path).ok().flatten()
    }
}

pub(super) fn prompt_cache_telemetry(data_root: &Path, since_ts: Option<f64>) -> Value {
    let mut tokens = Tokens::default();
    let mut by_scope = BTreeMap::<String, u64>::new();
    let path = data_root.join("metrics/prompt-cache-usage.jsonl");
    let mut names = Names::default();
    let _ = visit_jsonl(&path, |_, parsed| {
        let Some(row) = parsed.and_then(|event| UsageRow::parse(&event, &mut names)) else {
            return;
        };
        if since_ts.is_some_and(|since| row.ts < since) {
            return;
        }
        tokens.add(&row);
        let scope = safe_key(&row.scope, &by_scope);
        *by_scope.entry(scope).or_default() += 1;
    });
    json!({
        "requestCount": tokens.request_count,
        "promptTokens": tokens.prompt,
        "cachedTokens": tokens.cached,
        "totalTokens": tokens.total,
        "cacheHitRatio": if tokens.prompt > 0.0 { tokens.cached / tokens.prompt } else { 0.0 },
        "byScope": by_scope
    })
}

fn safe_key<T>(key: &str, values: &BTreeMap<String, T>) -> String {
    safe_key_with_limit(key, values, MAP_LIMIT)
}

fn safe_key_with_limit<T>(key: &str, values: &BTreeMap<String, T>, limit: usize) -> String {
    if values.contains_key(key) || values.len() < limit {
        key.into()
    } else {
        "__other__".into()
    }
}

fn provider_id(model: &str) -> &str {
    model
        .split_once('/')
        .map(|(provider, _)| provider)
        .filter(|provider| !provider.is_empty())
        .unwrap_or("custom")
}

fn remaining(provider: &str, sources: Option<&UsageMonitorSources<'_>>) -> Value {
    let view = sources.map_or_else(
        || crate::operations::unavailable_quota_view(provider),
        |sources| (sources.quota)(provider),
    );
    serde_json::to_value(view).unwrap_or(Value::Null)
}

fn provider_summary(
    mut values: BTreeMap<String, Tokens>,
    sources: Option<&UsageMonitorSources<'_>>,
) -> Value {
    for provider in sources
        .map(|sources| sources.quota_providers.as_slice())
        .unwrap_or_default()
    {
        if values.len() < PROVIDER_LIMIT {
            values.entry(provider.clone()).or_default();
        }
    }
    let mut providers = values.into_iter().map(|(provider, tokens)| {
        let mut value = tokens.value();
        let bucket = butler_core::json::object_mut(&mut value);
        bucket.insert("providerId".into(), json!(provider));
        bucket.insert("source".into(), json!("local_telemetry"));
        bucket.insert("remaining".into(), remaining(&provider, sources));
        bucket.insert("billing".into(), json!({ "available": false, "reason": "Provider billing adapter is not configured." }));
        value
    }).collect::<Vec<_>>();
    providers.sort_by(|left, right| {
        number(right.get("totalTokens"))
            .unwrap_or(0.0)
            .total_cmp(&number(left.get("totalTokens")).unwrap_or(0.0))
            .then_with(|| {
                number(right.get("promptTokens"))
                    .unwrap_or(0.0)
                    .total_cmp(&number(left.get("promptTokens")).unwrap_or(0.0))
            })
            .then_with(|| {
                left["providerId"]
                    .as_str()
                    .cmp(&right["providerId"].as_str())
            })
    });
    json!({ "activeProviderId": providers.first().and_then(|value| value["providerId"].as_str()), "providers": providers })
}
