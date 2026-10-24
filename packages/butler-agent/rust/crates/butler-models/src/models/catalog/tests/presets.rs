use super::*;

/// Provider, static preset, refreshed ids, "runs at effort" check, expected model.
type Case<'a> = (
    &'a str,
    &'a ModelPreset,
    &'a [&'a str],
    &'a dyn Fn(&str, ReasoningEffort) -> bool,
    &'a str,
);

// test-category: format-pin
#[test]
fn routine_preset_upgrades_only_to_a_newer_same_tier_model_at_the_same_effort() {
    super::browsing::assert_resolution_rules();
    let sol = ModelPreset {
        model: "openai/gpt-6-sol".into(),
        effort: ReasoningEffort::Medium,
    };
    let sonnet = ModelPreset {
        model: "anthropic/claude-sonnet-5".into(),
        effort: ReasoningEffort::Medium,
    };
    let flash = ModelPreset {
        model: "google/gemini-3.8-flash".into(),
        effort: ReasoningEffort::Medium,
    };
    let kimi = ModelPreset {
        model: "kimi/kimi-k2.7-code".into(),
        effort: ReasoningEffort::Medium,
    };
    let all = |_: &str, _: ReasoningEffort| true;
    let none = |_: &str, _: ReasoningEffort| false;
    let no_medium = |_: &str, effort: ReasoningEffort| effort != ReasoningEffort::Medium;
    let cases: [Case<'_>; 9] = [
        (
            "openai",
            &sol,
            &["gpt-6.1-sol", "gpt-7-astra"],
            &all,
            "openai/gpt-6.1-sol",
        ),
        (
            "openai",
            &sol,
            &["gpt-5.6-sol", "gpt-6-luna"],
            &all,
            "openai/gpt-6-sol",
        ),
        ("openai", &sol, &["gpt-6.1-sol"], &none, "openai/gpt-6-sol"),
        (
            "openai",
            &sol,
            &["gpt-6.1-sol"],
            &no_medium,
            "openai/gpt-6-sol",
        ),
        (
            "anthropic",
            &sonnet,
            &["claude-sonnet-5-1", "claude-opus-6"],
            &all,
            "anthropic/claude-sonnet-5-1",
        ),
        (
            "anthropic",
            &sonnet,
            &["claude-haiku-5"],
            &all,
            "anthropic/claude-sonnet-5",
        ),
        (
            "google",
            &flash,
            &["gemini-3.9-flash-lite", "gemini-3.9-flash"],
            &all,
            "google/gemini-3.9-flash",
        ),
        (
            "google",
            &flash,
            &["gemini-3.9-flash-preview-10-2026"],
            &all,
            "google/gemini-3.8-flash",
        ),
        ("kimi", &kimi, &["kimi-k3.1"], &all, "kimi/kimi-k2.7-code"),
    ];
    for (provider, preset, refreshed, runs, expected) in cases {
        let refreshed = refreshed
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>();
        let upgraded = upgrade_routine_preset(provider, preset, &refreshed, runs);
        assert_eq!(upgraded.model, expected, "{provider} {refreshed:?}");
        assert_eq!(upgraded.effort, ReasoningEffort::Medium);
    }
}
