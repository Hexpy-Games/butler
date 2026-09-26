use super::*;
use crate::models::*;
use std::sync::Mutex;

#[path = "test_support.rs"]
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

#[test]
fn invalid_usage_does_not_sample_clock_budget_or_create_storage() {
    let scratch = Scratch::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = PromptUsageMetrics::new(scratch.0.clone(), Arc::new(Clock(events.clone())));
    let source = BudgetSource {
        events: events.clone(),
        result: Ok(Some(budget())),
    };
    let mut attr = attribution();
    attr.budget_state_source = Some(&source);
    for (prompt, cached, total) in [
        (None, 0.0, None),
        (Some(-1.0), 0.0, None),
        (Some(f64::NAN), 0.0, None),
        (Some(f64::INFINITY), 0.0, None),
        (Some(1.0), f64::NAN, None),
        (Some(1.0), f64::NEG_INFINITY, None),
        (Some(1.0), 0.0, Some(f64::INFINITY)),
    ] {
        let mut row = input();
        row.prompt_tokens = prompt;
        row.cached_tokens = cached;
        row.total_tokens = total;
        row.usage_attribution = Some(&attr);
        sink.append(row).unwrap();
    }
    assert!(events.lock().unwrap().is_empty());
    assert!(!scratch.0.join("metrics").exists());
}

#[test]
fn getter_and_file_errors_propagate_and_each_append_reopens_selected_root() {
    let scratch = Scratch::new();
    let alternate = Scratch::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = PromptUsageMetrics::new(scratch.0.clone(), Arc::new(Clock(events.clone())));
    let source = BudgetSource {
        events: events.clone(),
        result: Err(ModelRoundError::InvocationFailure {
            code: Some("budget_failure".into()),
            message: "fixture".into(),
        }),
    };
    let mut attr = attribution();
    attr.budget_state_source = Some(&source);
    let mut row = input();
    row.usage_attribution = Some(&attr);
    assert!(
        matches!(sink.append(row), Err(ModelRoundError::InvocationFailure { code: Some(code), .. }) if code == "budget_failure")
    );
    assert!(!scratch.path().exists());
    assert_eq!(*events.lock().unwrap(), ["clock", "budget"]);

    let override_root = alternate.0.to_str().unwrap();
    let mut row = input();
    row.butler_data = Some(override_root);
    sink.append(row).unwrap();
    assert!(!scratch.path().exists());
    let previous = alternate.path().with_extension("old");
    std::fs::rename(alternate.path(), &previous).unwrap();
    let mut row = input();
    row.butler_data = Some(override_root);
    sink.append(row).unwrap();
    assert_eq!(
        std::fs::read_to_string(alternate.path()).unwrap(),
        std::fs::read_to_string(previous).unwrap()
    );
    std::fs::remove_file(alternate.path()).unwrap();
    std::fs::create_dir(alternate.path()).unwrap();
    let mut row = input();
    row.butler_data = Some(override_root);
    assert!(matches!(
        sink.append(row),
        Err(ModelRoundError::InvocationFailure { .. })
    ));
}
