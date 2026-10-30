//! Prompt-cache and web-search telemetry projections, streamed from DATA logs.

mod availability;
mod buckets;
mod history;
mod log;
mod plan;
mod row;
mod web;

use std::{collections::BTreeMap, path::Path};

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::health::{self, TranscriptActivityProjection};
use super::stream::visit_jsonl;

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
    /// Providers with registered credential bindings, in registry order.
    pub quota_providers: Vec<String>,
    /// Active signed-in ChatGPT account, independent of selected usage scope.
    pub chatgpt_account: Option<String>,
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
    /// Use the same owner table as the session usage projection.
    pub fn with_owners(owners: std::sync::Arc<crate::operations::UsageOwners>) -> Self {
        Self {
            log: Mutex::new(UsageLogIndex::with_owners(owners)),
            ..Default::default()
        }
    }

    /// Refresh and project local activity on the caller's blocking worker.
    pub fn history(
        &self,
        root: &Path,
        pricing: &dyn Fn(&str) -> Option<butler_models::models::ModelPricing>,
    ) -> std::io::Result<Value> {
        let mut log = self.log.lock();
        log.refresh(root, Some(pricing));
        log.history()
    }

    /// Refresh the incremental log before asynchronous legacy resolution.
    pub fn refresh_owners(
        &self,
        root: &Path,
        pricing: &dyn Fn(&str) -> Option<butler_models::models::ModelPricing>,
    ) {
        self.log.lock().refresh(root, Some(pricing));
    }

    /// Classify returned sessions from their windowed usage turns. The App
    /// supplies indexed schedule lookups; each session stops at its first
    /// non-schedule turn, without copying or serializing the log's turn ids.
    pub fn scheduled_sessions<E>(
        &self,
        view: &Value,
        is_scheduled: impl FnMut(&str) -> Result<bool, E>,
    ) -> Result<std::collections::HashSet<String>, E> {
        self.log.lock().scheduled_sessions(view, is_scheduled)
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
        self.log
            .lock()
            .refresh(data_root, sources.map(|s| s.pricing));
        self.read_prepared_at(data_root, session_id, usage_scope, since_ts, now, sources)
    }

    /// Build a view after refresh and asynchronous lineage resolution.
    pub fn read_prepared_at(
        &self,
        data_root: &Path,
        session_id: Option<&str>,
        usage_scope: Option<&str>,
        since_ts: Option<f64>,
        now: f64,
        sources: Option<&UsageMonitorSources<'_>>,
    ) -> Value {
        self.read_prepared_at_releasing(
            data_root,
            session_id,
            usage_scope,
            since_ts,
            now,
            sources,
            (),
        )
    }

    /// Release lineage serialization after the owner-dependent usage projection.
    #[allow(clippy::too_many_arguments)]
    pub fn read_prepared_at_releasing(
        &self,
        data_root: &Path,
        session_id: Option<&str>,
        usage_scope: Option<&str>,
        since_ts: Option<f64>,
        now: f64,
        sources: Option<&UsageMonitorSources<'_>>,
        projection_guard: impl Sized,
    ) -> Value {
        let session_id = session_id.filter(|id| !id.trim().is_empty());
        let pricing = sources.map(|sources| sources.pricing);
        let (buckets, timeline, top_sessions, previous, scope, by_role) = {
            let mut log = self.log.lock();
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
                scope.clone(),
                scope.as_ref().map(|_| log.by_role(window)),
            )
        };
        drop(projection_guard);
        let cost = buckets.cost_value();
        let (mut model_value, mut provider_buckets) = buckets.views();
        if let Some((by_role, subtasks)) = by_role {
            model_value["byRole"] = by_role;
            model_value["subtasks"] = subtasks;
        }
        plan::include_provider(&mut provider_buckets, sources);
        let web_search = availability::read_web_search(data_root, since_ts, now, self);
        let mut providers = provider_summary(provider_buckets, sources);
        self.log
            .lock()
            .attach_provider_usage(&mut providers, sources, now);
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
    if let Some(sources) = sources {
        values.retain(|provider, _| sources.quota_providers.contains(provider));
    }
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
    if let Some(sources) = sources {
        providers.sort_by_key(|value| {
            sources
                .quota_providers
                .iter()
                .position(|id| value["providerId"].as_str() == Some(id))
                .unwrap_or(usize::MAX)
        });
    }
    json!({ "activeProviderId": providers.first().and_then(|value| value["providerId"].as_str()), "providers": providers })
}
