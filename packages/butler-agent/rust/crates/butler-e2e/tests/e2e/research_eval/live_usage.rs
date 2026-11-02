//! Provider usage only: no tokenizer estimates or simulated cache hits.
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) fn canonical(body: &Value) -> Value {
    let input = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            if m["role"] == "tool" {
                json!({"type":"function_call_output","output":m["content"]})
            } else {
                m.clone()
            }
        })
        .collect::<Vec<_>>();
    json!({"input":input,"instructions":body["messages"][0]["content"]})
}

pub(super) fn lane(body: &Value) -> &'static str {
    let body = canonical(body);
    let users = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .map(crate::steward_presentation::stub::user_text)
        .collect::<Vec<_>>()
        .join("\n");
    if users.lines().any(|l| {
        l.starts_with("role: worker")
            || l.starts_with("Original request (highest priority): role: worker")
    }) {
        "worker"
    } else if crate::steward_presentation::stub::child_lane(&body)
        || body["instructions"]
            .as_str()
            .unwrap_or_default()
            .contains("You run one delegated Work for Butler")
    {
        "steward"
    } else {
        "butler"
    }
}

pub(super) fn received(body: &Value, task: &super::fixture::Task) -> BTreeSet<usize> {
    super::policy::received(&canonical(body), &task.spec)
}

pub(super) fn price(model: &str, usage: &Value) -> f64 {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap();
    let pricing = &catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_ref"] == model)
        .expect("catalog model")["pricing"];
    let input = usage["prompt_tokens"].as_u64().unwrap();
    let cached = usage["prompt_cache_hit_tokens"].as_u64().unwrap();
    let uncached = usage["prompt_cache_miss_tokens"].as_u64().unwrap();
    assert_eq!(cached + uncached, input, "provider cache accounting");
    let tier = pricing["prompt_tiers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| input > t["above_input_tokens"].as_u64().unwrap())
        .max_by_key(|t| t["above_input_tokens"].as_u64().unwrap());
    let rate = |key: &str| {
        tier.and_then(|t| t[key].as_f64())
            .or(pricing[key].as_f64())
            .unwrap()
            / 1e6
    };
    uncached as f64 * rate("input_per_mtok_usd")
        + cached as f64 * rate("cached_input_per_mtok_usd")
        + usage["completion_tokens"].as_u64().unwrap() as f64 * rate("output_per_mtok_usd")
}

pub(super) fn valid(usage: &Value) -> bool {
    [
        "prompt_tokens",
        "prompt_cache_hit_tokens",
        "prompt_cache_miss_tokens",
        "completion_tokens",
    ]
    .iter()
    .all(|k| usage[k].as_u64().is_some())
        && usage["prompt_tokens"].as_u64()
            == usage["prompt_cache_hit_tokens"]
                .as_u64()
                .zip(usage["prompt_cache_miss_tokens"].as_u64())
                .map(|(a, b)| a + b)
}
