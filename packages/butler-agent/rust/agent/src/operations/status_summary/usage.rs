//! Prompt-cache and web-search telemetry projections, streamed from DATA logs.

#[path = "usage_availability.rs"]
mod availability;

use std::{collections::BTreeMap, path::Path};

use serde_json::{Value, json};

use super::stream::{number, visit_jsonl};

const MAP_LIMIT: usize = 512;
const PROVIDER_LIMIT: usize = 64;

#[derive(Clone, Default)]
struct Tokens {
    request_count: u64,
    prompt: f64,
    cached: f64,
    uncached: f64,
    output: f64,
    total: f64,
    missing: u64,
}

impl Tokens {
    fn add(&mut self, event: &Value) {
        let prompt = number(event.get("promptTokens")).unwrap_or(0.0);
        let cached = number(event.get("cachedTokens")).unwrap_or(0.0);
        let total = number(event.get("totalTokens"));
        self.request_count += 1;
        self.prompt += prompt;
        self.cached += cached;
        self.uncached += (prompt - cached).max(0.0);
        if let Some(total) = total {
            self.total += total;
            self.output += (total - prompt).max(0.0);
        } else {
            self.missing += 1;
        }
    }

    fn value(&self) -> Value {
        json!({
            "requestCount": self.request_count,
            "promptTokens": self.prompt,
            "cachedTokens": self.cached,
            "uncachedTokens": self.uncached,
            "outputTokens": self.output,
            "totalTokens": self.total,
            "missingTotalTokenCount": self.missing
        })
    }
}

pub(super) fn read_usage(
    data_root: &Path,
    since_ts: Option<f64>,
    session_id: Option<&str>,
    transcript_activity: &super::health::TranscriptActivityProjection,
) -> Value {
    let mut model = Tokens::default();
    let mut by_scope = BTreeMap::<String, u64>::new();
    let mut by_scope_usage = BTreeMap::<String, Tokens>::new();
    let mut by_model = BTreeMap::<String, Tokens>::new();
    let mut by_turn = BTreeMap::<String, Tokens>::new();
    let mut by_phase = BTreeMap::<String, Tokens>::new();
    let mut by_turn_phase = BTreeMap::<String, Tokens>::new();
    let mut by_section = BTreeMap::<String, (u64, f64, f64)>::new();
    let mut budget_states = BTreeMap::<String, Value>::new();
    let mut provider_buckets = BTreeMap::<String, Tokens>::new();
    let mut missing_key = 0_u64;
    let mut missing_retention = 0_u64;
    let prompt_path = data_root.join("metrics/prompt-cache-usage.jsonl");
    let _ = visit_jsonl(&prompt_path, |_, parsed| {
        let Ok(event) = parsed else { return };
        if !valid_prompt_event(&event) {
            return;
        }
        if since_ts.is_some_and(|since| number(event.get("ts")).unwrap_or(0.0) < since) {
            return;
        }
        model.add(&event);
        let scope = safe_key(event["scope"].as_str().unwrap_or(""), &by_scope);
        *by_scope.entry(scope.clone()).or_default() += 1;
        by_scope_usage.entry(scope.clone()).or_default().add(&event);
        let model_key = safe_key(event["model"].as_str().unwrap_or(""), &by_model);
        by_model.entry(model_key).or_default().add(&event);
        let turn = safe_text(event.get("turnId").and_then(Value::as_str), "unknown-turn");
        let turn_key = safe_key(&turn, &by_turn);
        let phase = safe_text(event.get("phase").and_then(Value::as_str), &scope);
        let phase_key = safe_key(&phase, &by_phase);
        let turn_phase = format!("{turn}:{phase}");
        let turn_phase_key = safe_key(&turn_phase, &by_turn_phase);
        by_turn.entry(turn_key.clone()).or_default().add(&event);
        by_phase.entry(phase_key.clone()).or_default().add(&event);
        by_turn_phase.entry(turn_phase_key).or_default().add(&event);
        let provider = provider_id(event["model"].as_str().unwrap_or(""));
        let provider_key = safe_key_with_limit(&provider, &provider_buckets, PROVIDER_LIMIT);
        provider_buckets
            .entry(provider_key)
            .or_default()
            .add(&event);
        if event
            .get("promptCacheKey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            missing_key += 1;
        }
        if event
            .get("promptCacheRetention")
            .and_then(Value::as_str)
            .is_none()
        {
            missing_retention += 1;
        }
        if let Some(state) = event.get("budgetState").filter(|value| value.is_object()) {
            let state_key = safe_key(&turn, &budget_states);
            budget_states.insert(state_key, state.clone());
        }
        if let Some(sections) = event.get("promptSections").and_then(Value::as_array) {
            for section in sections {
                let Some(id) = section
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                else {
                    continue;
                };
                let section_key = safe_key(id, &by_section);
                let bucket = by_section.entry(section_key).or_default();
                bucket.0 += 1;
                bucket.1 += number(section.get("chars")).unwrap_or(0.0).max(0.0);
                bucket.2 += number(section.get("estimatedTokens"))
                    .unwrap_or(0.0)
                    .max(0.0);
            }
        }
    });
    let prompt_hit_ratio = if model.prompt > 0.0 {
        model.cached / model.prompt
    } else {
        0.0
    };
    let mut model_value = model.value();
    let fields = crate::json::object_mut(&mut model_value);
    fields.insert("cacheHitRatio".into(), json!(prompt_hit_ratio));
    fields.insert("byScope".into(), map_numbers(by_scope));
    fields.insert("byScopeUsage".into(), map_tokens(by_scope_usage));
    fields.insert("byModel".into(), map_tokens(by_model));
    fields.insert("byTurn".into(), map_tokens(by_turn));
    fields.insert("byPhase".into(), map_tokens(by_phase));
    fields.insert("byTurnPhase".into(), map_tokens(by_turn_phase));
    fields.insert("bySection".into(), map_sections(by_section));
    fields.insert(
        "budgetStates".into(),
        Value::Object(budget_states.into_iter().collect()),
    );
    fields.insert(
        "promptCache".into(),
        json!({ "missingKeyCount": missing_key, "missingRetentionCount": missing_retention }),
    );
    let web_search = availability::read_web_search(data_root, since_ts);
    let providers = provider_summary(provider_buckets);
    let (tools, transcript_activity_status, tools_availability) =
        availability::read_tools(data_root, session_id, since_ts, transcript_activity);
    json!({
        "filters": { "sessionId": session_id, "sinceTs": since_ts },
        "model": model_value,
        "webSearch": web_search,
        "tools": tools,
        "providerUsage": providers,
        "cost": {
            "available": false,
            "estimatedUsd": null,
            "reason": "No authoritative provider price table is configured for this runtime/model."
        },
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

pub(super) fn prompt_cache_telemetry(data_root: &Path, since_ts: Option<f64>) -> Value {
    let mut tokens = Tokens::default();
    let mut by_scope = BTreeMap::<String, u64>::new();
    let path = data_root.join("metrics/prompt-cache-usage.jsonl");
    let _ = visit_jsonl(&path, |_, parsed| {
        let Ok(event) = parsed else { return };
        if !valid_prompt_event(&event)
            || since_ts.is_some_and(|since| number(event.get("ts")).unwrap_or(0.0) < since)
        {
            return;
        }
        tokens.add(&event);
        let scope = safe_key(event["scope"].as_str().unwrap_or(""), &by_scope);
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

fn valid_prompt_event(value: &Value) -> bool {
    number(value.get("ts")).is_some()
        && value.get("model").and_then(Value::as_str).is_some()
        && value.get("scope").and_then(Value::as_str).is_some()
        && number(value.get("promptTokens")).is_some()
        && number(value.get("cachedTokens")).is_some()
}

fn map_tokens(values: BTreeMap<String, Tokens>) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key, value.value()))
            .collect(),
    )
}

fn map_numbers(values: BTreeMap<String, u64>) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key, json!(value)))
            .collect(),
    )
}

fn map_sections(values: BTreeMap<String, (u64, f64, f64)>) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, (requests, chars, tokens))| {
                (
                    key,
                    json!({
                        "requestCount": requests, "chars": chars, "estimatedTokens": tokens
                    }),
                )
            })
            .collect(),
    )
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

fn safe_text(value: Option<&str>, fallback: &str) -> String {
    value
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .unwrap_or(fallback)
        .into()
}

fn provider_id(model: &str) -> String {
    model
        .split_once('/')
        .map(|(provider, _)| provider)
        .filter(|provider| !provider.is_empty())
        .unwrap_or("custom")
        .into()
}

fn provider_summary(values: BTreeMap<String, Tokens>) -> Value {
    let mut providers = values.into_iter().map(|(provider, tokens)| {
        let mut value = tokens.value();
        let bucket = crate::json::object_mut(&mut value);
        bucket.insert("providerId".into(), json!(provider));
        bucket.insert("source".into(), json!("local_telemetry"));
        bucket.insert("remaining".into(), json!({
            "available": false, "stale": false, "sourceKind": "provider_quota",
            "sourceId": format!("{provider}-unconfigured"), "planKind": "unknown", "planName": null,
            "windows": [], "fetchedAt": null,
            "reason": { "code": "provider_quota_surface_unavailable", "message": "Provider quota adapter is not configured." }
        }));
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
