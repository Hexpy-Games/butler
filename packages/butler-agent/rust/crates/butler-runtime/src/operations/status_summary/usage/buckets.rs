//! Per-request usage rows folded into the usage monitor's token buckets and
//! its catalog-price cost estimate.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use butler_models::models::ModelPricing;

use super::row::UsageRow;
use super::{PROVIDER_LIMIT, provider_id, safe_key, safe_key_with_limit};
use crate::operations::usage_cost::UsageTotals;

#[derive(Clone, Default)]
pub(super) struct Tokens {
    pub(super) request_count: u64,
    pub(super) prompt: f64,
    pub(super) cached: f64,
    uncached: f64,
    output: f64,
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
    by_scope: BTreeMap<String, u64>,
    by_scope_usage: BTreeMap<String, Tokens>,
    by_model: BTreeMap<String, Tokens>,
    by_phase: BTreeMap<String, Tokens>,
    by_section: BTreeMap<String, (u64, f64, f64)>,
    providers: BTreeMap<String, Tokens>,
    missing_key: u64,
    missing_retention: u64,
    /// Whether rows are priced (the catalog was given).
    priced: bool,
    prices: BTreeMap<String, Option<ModelPricing>>,
    cost: UsageTotals,
    cost_by_work: BTreeMap<String, UsageTotals>,
}

impl Buckets {
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
        let scope = safe_key(&row.scope, &self.by_scope);
        *self.by_scope.entry(scope.clone()).or_default() += 1;
        self.by_scope_usage
            .entry(scope.clone())
            .or_default()
            .add(row);
        let model_key = safe_key(&row.model, &self.by_model);
        self.by_model.entry(model_key).or_default().add(row);
        let phase = row.phase.as_deref().unwrap_or(&scope);
        let phase_key = safe_key(phase, &self.by_phase);
        self.by_phase.entry(phase_key).or_default().add(row);
        let provider = provider_id(&row.model);
        let provider_key = safe_key_with_limit(&provider, &self.providers, PROVIDER_LIMIT);
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
            let section_key = safe_key(&section.id, &self.by_section);
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
            .entry(event.model.clone())
            .or_insert_with(|| pricing(&event.model));
        self.cost.add(&event, price.as_ref());
        let work = work_kind(&row.scope);
        self.cost_by_work
            .entry(work.into())
            .or_default()
            .add(&event, price.as_ref());
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
        (value, self.providers.clone())
    }
}

fn map_tokens(values: &BTreeMap<String, Tokens>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| (key.clone(), value.value()))
            .collect(),
    )
}

fn map_sections(values: &BTreeMap<String, (u64, f64, f64)>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, (requests, chars, tokens))| {
                (
                    key.clone(),
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
