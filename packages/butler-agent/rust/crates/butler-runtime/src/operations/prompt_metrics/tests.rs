use super::*;
use butler_models::models::*;
use std::sync::Mutex;

mod support;
use support::*;

#[test]
fn append_matches_actual_bun_optional_and_nonfinite_metadata() {
    let scratch = Scratch::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = PromptUsageMetrics::new(scratch.0.clone(), Arc::new(Clock(events.clone())));
    sink.append(input()).unwrap();

    let state = budget();
    let sections = [PromptUsageSectionAttribution {
        id: "원문 😀".into(),
        chars: 19.0,
        estimated_tokens: 4.75,
    }];
    let mut attr = attribution();
    attr.turn_id = Some("turn-1");
    attr.phase = Some("memory");
    attr.round_index = Some(2.0);
    attr.reasoning_effort = Some(&ReasoningEffort::High);
    attr.budget_state = Some(&state);
    attr.prompt_sections = Some(&sections);
    let mut row = input();
    row.cached_tokens = 20.0;
    row.total_tokens = Some(130.0);
    row.cache_write_tokens = Some(Some(f64::NAN));
    row.prompt_cache_key = Some("cache-fixture");
    row.prompt_cache_retention = Some(PromptCacheRetention::Hours24);
    row.usage_attribution = Some(&attr);
    sink.append(row).unwrap();

    let mut replacement = state.clone();
    replacement.request_count = 9.0;
    let source = BudgetSource {
        events: events.clone(),
        result: Ok(Some(replacement)),
    };
    attr.budget_state_source = Some(&source);
    let mut row = input();
    row.usage_attribution = Some(&attr);
    sink.append(row).unwrap();

    let fallback = BudgetSource {
        events: events.clone(),
        result: Ok(None),
    };
    attr.budget_state_source = Some(&fallback);
    attr.round_index = Some(f64::NAN);
    attr.prompt_sections = Some(&[]);
    let mut row = input();
    row.cache_write_tokens = Some(None);
    row.usage_attribution = Some(&attr);
    sink.append(row).unwrap();
    let mut row = input();
    row.cache_write_tokens = Some(Some(f64::INFINITY));
    sink.append(row).unwrap();

    let expected: serde_json::Value =
        serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    let lines = expected["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>()
        .join("");
    assert_eq!(std::fs::read_to_string(scratch.path()).unwrap(), lines);
    assert_eq!(
        *events.lock().unwrap(),
        [
            "clock", "clock", "clock", "budget", "clock", "budget", "clock"
        ]
    );
}
