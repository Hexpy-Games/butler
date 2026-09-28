//! Per-request usage rows folded into the usage monitor's token buckets and
//! its catalog-price cost estimate.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};

use butler_models::models::ModelPricing;

use super::super::stream::number;
use super::{PROVIDER_LIMIT, provider_id, safe_key, safe_key_with_limit, safe_text};
use crate::operations::usage_cost::{UsageEvent, UsageTotals};

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
    pub(super) fn add(&mut self, event: &Value) {
        let prompt = number(event.get("promptTokens")).unwrap_or(0.0);
        let cached = number(event.get("cachedTokens")).unwrap_or(0.0);
        let total = number(event.get("totalTokens"));
        self.request_count += 1;
        self.prompt += prompt;
        self.cached += cached;
        self.uncached += (prompt - cached).max(0.0);
        if let Some(reasoning) = number(event.get("reasoningTokens")) {
            *self.reasoning.get_or_insert(0.0) += reasoning.max(0.0);
        }
        if let Some(total) = total {
            self.total += total;
            self.output += (total - prompt).max(0.0);
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
type PriceLookup<'a> = &'a dyn Fn(&str) -> Option<ModelPricing>;

/// Every aggregation the usage monitor reports, filled row by row.
pub(super) struct Buckets<'a> {
    model: Tokens,
    by_scope: BTreeMap<String, u64>,
    by_scope_usage: BTreeMap<String, Tokens>,
    by_model: BTreeMap<String, Tokens>,
    by_turn: BTreeMap<String, Tokens>,
    by_phase: BTreeMap<String, Tokens>,
    by_turn_phase: BTreeMap<String, Tokens>,
    by_section: BTreeMap<String, (u64, f64, f64)>,
    budget_states: BTreeMap<String, Value>,
    providers: BTreeMap<String, Tokens>,
    missing_key: u64,
    missing_retention: u64,
    pricing: Option<PriceLookup<'a>>,
    prices: BTreeMap<String, Option<ModelPricing>>,
    cost: UsageTotals,
}

impl<'a> Buckets<'a> {
    pub(super) fn new(pricing: Option<PriceLookup<'a>>) -> Self {
        Self {
            model: Tokens::default(),
            by_scope: BTreeMap::new(),
            by_scope_usage: BTreeMap::new(),
            by_model: BTreeMap::new(),
            by_turn: BTreeMap::new(),
            by_phase: BTreeMap::new(),
            by_turn_phase: BTreeMap::new(),
            by_section: BTreeMap::new(),
            budget_states: BTreeMap::new(),
            providers: BTreeMap::new(),
            missing_key: 0,
            missing_retention: 0,
            pricing,
            prices: BTreeMap::new(),
            cost: UsageTotals::default(),
        }
    }

    pub(super) fn add(&mut self, event: &Value) {
        self.model.add(event);
        let scope = safe_key(event["scope"].as_str().unwrap_or(""), &self.by_scope);
        *self.by_scope.entry(scope.clone()).or_default() += 1;
        self.by_scope_usage
            .entry(scope.clone())
            .or_default()
            .add(event);
        let model = event["model"].as_str().unwrap_or("");
        let model_key = safe_key(model, &self.by_model);
        self.by_model.entry(model_key).or_default().add(event);
        let turn = safe_text(event.get("turnId").and_then(Value::as_str), "unknown-turn");
        let phase = safe_text(event.get("phase").and_then(Value::as_str), &scope);
        let turn_key = safe_key(&turn, &self.by_turn);
        let phase_key = safe_key(&phase, &self.by_phase);
        let turn_phase_key = safe_key(&format!("{turn}:{phase}"), &self.by_turn_phase);
        self.by_turn.entry(turn_key).or_default().add(event);
        self.by_phase.entry(phase_key).or_default().add(event);
        self.by_turn_phase
            .entry(turn_phase_key)
            .or_default()
            .add(event);
        let provider = provider_id(model);
        let provider_key = safe_key_with_limit(&provider, &self.providers, PROVIDER_LIMIT);
        self.providers.entry(provider_key).or_default().add(event);
        self.add_cache_facts(event, &turn);
        self.add_sections(event);
        self.add_cost(event);
    }

    fn add_cache_facts(&mut self, event: &Value, turn: &str) {
        let key = event.get("promptCacheKey").and_then(Value::as_str);
        if key.filter(|value| !value.is_empty()).is_none() {
            self.missing_key += 1;
        }
        if event
            .get("promptCacheRetention")
            .and_then(Value::as_str)
            .is_none()
        {
            self.missing_retention += 1;
        }
        if let Some(state) = event.get("budgetState").filter(|value| value.is_object()) {
            let state_key = safe_key(turn, &self.budget_states);
            self.budget_states.insert(state_key, state.clone());
        }
    }

    fn add_sections(&mut self, event: &Value) {
        let Some(sections) = event.get("promptSections").and_then(Value::as_array) else {
            return;
        };
        for section in sections {
            let Some(id) = section
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
            else {
                continue;
            };
            let section_key = safe_key(id, &self.by_section);
            let bucket = self.by_section.entry(section_key).or_default();
            bucket.0 += 1;
            bucket.1 += number(section.get("chars")).unwrap_or(0.0).max(0.0);
            bucket.2 += number(section.get("estimatedTokens"))
                .unwrap_or(0.0)
                .max(0.0);
        }
    }

    fn add_cost(&mut self, event: &Value) {
        let Some(pricing) = self.pricing else {
            return;
        };
        let Ok(event) = UsageEvent::deserialize(event) else {
            return;
        };
        let price = self
            .prices
            .entry(event.model.clone())
            .or_insert_with(|| pricing(&event.model));
        self.cost.add(&event, price.as_ref());
    }

    /// The monitor's `cost` object.
    pub(super) fn cost_value(&self) -> Value {
        if self.pricing.is_none() {
            return json!({
                "available": false,
                "estimatedUsd": null,
                "reason": "No authoritative provider price table is configured for this runtime/model."
            });
        }
        let cost = self.cost.cost();
        json!({
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

    /// The `model` object and the per-provider buckets.
    pub(super) fn into_views(self) -> (Value, BTreeMap<String, Tokens>) {
        let ratio = if self.model.prompt > 0.0 {
            self.model.cached / self.model.prompt
        } else {
            0.0
        };
        let mut value = self.model.value();
        let fields = butler_core::json::object_mut(&mut value);
        fields.insert("cacheHitRatio".into(), json!(ratio));
        fields.insert("byScope".into(), json!(self.by_scope));
        fields.insert("byScopeUsage".into(), map_tokens(self.by_scope_usage));
        fields.insert("byModel".into(), map_tokens(self.by_model));
        fields.insert("byTurn".into(), map_tokens(self.by_turn));
        fields.insert("byPhase".into(), map_tokens(self.by_phase));
        fields.insert("byTurnPhase".into(), map_tokens(self.by_turn_phase));
        fields.insert("bySection".into(), map_sections(self.by_section));
        fields.insert(
            "budgetStates".into(),
            Value::Object(self.budget_states.into_iter().collect()),
        );
        fields.insert(
            "promptCache".into(),
            json!({ "missingKeyCount": self.missing_key, "missingRetentionCount": self.missing_retention }),
        );
        (value, self.providers)
    }
}

fn map_tokens(values: BTreeMap<String, Tokens>) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key, value.value()))
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
