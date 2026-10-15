//! Per-request usage rows folded into the usage monitor's token buckets and
//! its catalog-price cost estimate.

use std::{collections::BTreeMap, sync::Arc};

use serde_json::{Value, json};

use butler_models::models::ModelPricing;

use super::row::UsageRow;
use super::{PROVIDER_LIMIT, provider_id};
use crate::operations::usage_cost::UsageTotals;

#[derive(Clone, Default)]
pub(super) struct Tokens {
    pub(super) request_count: u64,
    pub(super) prompt: f64,
    pub(super) cached: f64,
    uncached: f64,
    pub(super) output: f64,
    reasoning: Option<f64>,
    pub(super) total: f64,
    missing: u64,
}

impl Tokens {
    pub(super) fn add(&mut self, row: &UsageRow) {
        self.request_count += 1;
        self.prompt += row.prompt;
        self.cached += row.cached;
        self.uncached += (row.prompt - row.cached).max(0.0);
        if let Some(reasoning) = row.reasoning {
            *self.reasoning.get_or_insert(0.0) += reasoning.max(0.0);
        }
        if let Some(total) = row.total {
            self.total += total;
            self.output += (total - row.prompt).max(0.0);
        } else {
            self.missing += 1;
        }
    }

    pub(super) fn merge(&mut self, other: &Self) {
        self.request_count += other.request_count;
        self.prompt += other.prompt;
        self.cached += other.cached;
        self.uncached += other.uncached;
        self.output += other.output;
        self.total += other.total;
        self.missing += other.missing;
        if let Some(value) = other.reasoning {
            *self.reasoning.get_or_insert(0.0) += value;
        }
    }

    pub(super) fn value(&self) -> Value {
        let mut value = json!({
            "requestCount": self.request_count,
            "promptTokens": self.prompt,
            "cachedTokens": self.cached,
            "uncachedTokens": self.uncached,
            "outputTokens": self.output,
            "totalTokens": self.total,
            "missingTotalTokenCount": self.missing
        });
        if let Some(reasoning) = self.reasoning {
            butler_core::json::object_mut(&mut value)
                .insert("reasoningTokens".into(), json!(reasoning));
        }
        value
    }
}

/// The catalog list price of a model ref.
pub(super) type PriceLookup<'a> = &'a dyn Fn(&str) -> Option<ModelPricing>;

/// Every aggregation the usage monitor reports, filled row by row.
#[derive(Clone)]
pub(super) struct Buckets {
    model: Tokens,
    by_scope: BTreeMap<Arc<str>, u64>,
    by_scope_usage: BTreeMap<Arc<str>, Tokens>,
    by_model: BTreeMap<Arc<str>, Tokens>,
    by_phase: BTreeMap<Arc<str>, Tokens>,
    by_section: BTreeMap<Arc<str>, (u64, f64, f64)>,
    providers: BTreeMap<Arc<str>, Tokens>,
    missing_key: u64,
    missing_retention: u64,
    /// Whether rows are priced (the catalog was given).
    priced: bool,
    prices: BTreeMap<Arc<str>, Option<ModelPricing>>,
    cost: UsageTotals,
    cost_by_work: BTreeMap<String, UsageTotals>,
}

impl Buckets {
    pub(super) fn tokens(&self) -> &Tokens {
        &self.model
    }

    pub(super) fn new(priced: bool) -> Self {
        Self {
            model: Tokens::default(),
            by_scope: BTreeMap::new(),
            by_scope_usage: BTreeMap::new(),
            by_model: BTreeMap::new(),
            by_phase: BTreeMap::new(),
            by_section: BTreeMap::new(),
            providers: BTreeMap::new(),
            missing_key: 0,
            missing_retention: 0,
            priced,
            prices: BTreeMap::new(),
            cost: UsageTotals::default(),
            cost_by_work: BTreeMap::new(),
        }
    }

    pub(super) fn add(&mut self, row: &UsageRow, pricing: Option<PriceLookup<'_>>) {
        self.model.add(row);
        let scope = bounded_key(&row.scope, &self.by_scope, super::MAP_LIMIT);
        *self.by_scope.entry(scope.clone()).or_default() += 1;
        self.by_scope_usage
            .entry(scope.clone())
            .or_default()
            .add(row);
        let model_key = row.model.clone();
        self.by_model.entry(model_key).or_default().add(row);
        let phase = row.phase.as_ref().unwrap_or(&scope);
        let phase_key = bounded_key(phase, &self.by_phase, super::MAP_LIMIT);
        self.by_phase.entry(phase_key).or_default().add(row);
        let provider = provider_id(&row.model);
        let provider_key = self
            .providers
            .get_key_value(provider)
            .map(|(key, _)| key.clone())
            .unwrap_or_else(|| {
                Arc::from(if self.providers.len() < PROVIDER_LIMIT {
                    provider
                } else {
                    "__other__"
                })
            });
        self.providers.entry(provider_key).or_default().add(row);
        self.missing_key += u64::from(!row.has_cache_key);
        self.missing_retention += u64::from(!row.has_retention);
        self.add_sections(row);
        if let Some(pricing) = pricing {
            self.add_cost(row, pricing);
        }
    }

    fn add_sections(&mut self, row: &UsageRow) {
        for section in &row.sections {
            let section_key = bounded_key(&section.id, &self.by_section, super::MAP_LIMIT);
            let bucket = self.by_section.entry(section_key).or_default();
            bucket.0 += 1;
            bucket.1 += section.chars;
            bucket.2 += section.estimated_tokens;
        }
    }

    fn add_cost(&mut self, row: &UsageRow, pricing: PriceLookup<'_>) {
        let Some(event) = row.cost_event() else {
            return;
        };
        let price = self
            .prices
            .entry(row.model.clone())
            .or_insert_with(|| pricing(&event.model));
        self.cost.add(&event, price.as_ref());
        let work = work_kind(&row.scope);
        self.cost_by_work
            .entry(work.into())
            .or_default()
            .add(&event, price.as_ref());
    }

    pub(super) fn merge(&mut self, other: &Self) {
        self.model.merge(&other.model);
        self.missing_key += other.missing_key;
        self.missing_retention += other.missing_retention;
        for (key, value) in &other.by_scope {
            let key = bounded_key(key, &self.by_scope, super::MAP_LIMIT);
            *self.by_scope.entry(key).or_default() += value;
        }
        for (target, source, limit) in [
            (
                &mut self.by_scope_usage,
                &other.by_scope_usage,
                super::MAP_LIMIT,
            ),
            (&mut self.by_model, &other.by_model, usize::MAX),
            (&mut self.by_phase, &other.by_phase, super::MAP_LIMIT),
            (&mut self.providers, &other.providers, PROVIDER_LIMIT),
        ] {
            for (key, value) in source {
                let key = bounded_key(key, target, limit);
                target.entry(key).or_default().merge(value);
            }
        }
        for (key, value) in &other.by_section {
            let key = bounded_key(key, &self.by_section, super::MAP_LIMIT);
            let target = self.by_section.entry(key).or_default();
            target.0 += value.0;
            target.1 += value.1;
            target.2 += value.2;
        }
        self.cost.merge(&other.cost);
        for (key, value) in &other.cost_by_work {
            self.cost_by_work
                .entry(key.clone())
                .or_default()
                .merge(value);
        }
    }

    /// The monitor's `cost` object.
    pub(super) fn cost_value(&self) -> Value {
        if !self.priced {
            return json!({
                "available": false,
                "estimatedUsd": null,
                "reason": "No authoritative provider price table is configured for this runtime/model."
            });
        }
        let mut value = cost_value(&self.cost);
        // The total covers every request in the selected window. Fixed work
        // buckets keep memory separate even when thousands of revision/session
        // scopes overflow the token view's bounded byScope map.
        butler_core::json::object_mut(&mut value).insert(
            "byWork".into(),
            Value::Object(
                self.cost_by_work
                    .iter()
                    .map(|(work, totals)| (work.clone(), cost_value(totals)))
                    .collect(),
            ),
        );
        value
    }

    /// The `model` object and the per-provider buckets.
    pub(super) fn views(&self) -> (Value, BTreeMap<String, Tokens>) {
        let ratio = if self.model.prompt > 0.0 {
            self.model.cached / self.model.prompt
        } else {
            0.0
        };
        let mut value = self.model.value();
        let fields = butler_core::json::object_mut(&mut value);
        fields.insert("cacheHitRatio".into(), json!(ratio));
        fields.insert("byScope".into(), json!(self.by_scope));
        fields.insert("byScopeUsage".into(), map_tokens(&self.by_scope_usage));
        fields.insert("byModel".into(), map_tokens(&self.by_model));
        fields.insert("byPhase".into(), map_tokens(&self.by_phase));
        fields.insert("bySection".into(), map_sections(&self.by_section));
        fields.insert(
            "promptCache".into(),
            json!({ "missingKeyCount": self.missing_key, "missingRetentionCount": self.missing_retention }),
        );
        (
            value,
            self.providers
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect(),
        )
    }
}

fn map_tokens(values: &BTreeMap<Arc<str>, Tokens>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| (key.to_string(), value.value()))
            .collect(),
    )
}

fn map_sections(values: &BTreeMap<Arc<str>, (u64, f64, f64)>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, (requests, chars, tokens))| {
                (
                    key.to_string(),
                    json!({
                        "requestCount": requests, "chars": chars, "estimatedTokens": tokens
                    }),
                )
            })
            .collect(),
    )
}

fn cost_value(totals: &UsageTotals) -> Value {
    let cost = totals.cost();
    json!({
        "requestCount": totals.request_count,
        "available": cost.available,
        "estimatedUsd": cost.usd,
        "reason": match cost.reason {
            None => "estimated_from_catalog_prices",
            Some(reason) => reason.code(),
        },
        "asOf": cost.as_of,
        "pricedModelRefs": cost.priced_model_refs,
    })
}

// Scopes come from the model-call owners; unrecognized work stays visible.
fn work_kind(scope: &str) -> &'static str {
    if scope.starts_with("memory-extract:")
        || scope == "profile-extractor"
        || (scope.starts_with("cognition:") && scope.ends_with(":profile-extractor"))
    {
        "memory"
    } else if scope.starts_with("btcc-guided:")
        || matches!(scope, "session-turn" | "btcc-agent-loop")
    {
        "conversation"
    } else {
        "other"
    }
}

fn bounded_key<T>(name: &Arc<str>, values: &BTreeMap<Arc<str>, T>, limit: usize) -> Arc<str> {
    if values.contains_key(name) || values.len() < limit {
        name.clone()
    } else {
        Arc::from("__other__")
    }
}
/// Internal work requires affirmative provenance from a known telemetry owner.
pub(super) fn internal_work(scope: &str) -> bool {
    work_kind(scope) == "memory"
}
