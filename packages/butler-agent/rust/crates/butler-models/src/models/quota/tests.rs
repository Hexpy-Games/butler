//! Format pins of every quota source: the Codex and Anthropic unified
//! response headers, and the Codex `wham/usage` and Z.AI `quota/limit`
//! bodies (their cases live next to each parser).

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use super::*;

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

const NOW: i64 = 1_790_000_000_000;

pub(crate) fn codex_windows_parse_used_percent_duration_and_reset() {
    let reading = parse_quota_headers(
        "openai",
        &headers(&[
            ("x-codex-primary-used-percent", "12.5"),
            ("x-codex-primary-window-minutes", "300"),
            ("x-codex-primary-reset-after-seconds", "600"),
            ("x-codex-secondary-used-percent", "40"),
            ("x-codex-secondary-window-minutes", "10080"),
            ("x-codex-secondary-reset-at", "1790100000"),
        ]),
        NOW,
    )
    .unwrap();
    assert_eq!(reading.provider_id, "openai");
    assert_eq!(
        reading.windows,
        vec![
            ProviderQuotaWindow {
                id: "tokens-5-hour".into(),
                used_percent: 12.5,
                window_minutes: Some(300),
                resets_at_ms: Some(NOW + 600_000),
            },
            ProviderQuotaWindow {
                id: "tokens-weekly".into(),
                used_percent: 40.0,
                window_minutes: Some(10_080),
                resets_at_ms: Some(1_790_100_000_000),
            },
        ]
    );
}

/// The shape a Plus account's Codex reply carries (USE-01 cassette): a
/// weekly primary window and a zero-minute secondary one it does not have.
pub(crate) fn codex_zero_minute_window_is_absent_and_the_relative_reset_wins() {
    let reading = parse_quota_headers(
        "openai",
        &headers(&[
            ("x-codex-primary-used-percent", "1"),
            ("x-codex-primary-window-minutes", "10080"),
            ("x-codex-primary-reset-after-seconds", "532090"),
            ("x-codex-primary-reset-at", "1791095753"),
            ("x-codex-primary-over-secondary-limit-percent", "0"),
            ("x-codex-secondary-used-percent", "0"),
            ("x-codex-secondary-window-minutes", "0"),
            ("x-codex-secondary-reset-after-seconds", "0"),
        ]),
        NOW,
    )
    .unwrap();
    assert_eq!(
        reading.windows,
        vec![ProviderQuotaWindow {
            id: "tokens-weekly".into(),
            used_percent: 1.0,
            window_minutes: Some(10_080),
            resets_at_ms: Some(NOW + 532_090_000),
        }]
    );
}

pub(crate) fn anthropic_unified_utilization_is_a_fraction() {
    let reading = parse_quota_headers(
        "anthropic",
        &headers(&[
            ("anthropic-ratelimit-unified-5h-utilization", "0.25"),
            ("anthropic-ratelimit-unified-5h-reset", "1790003600"),
            ("anthropic-ratelimit-unified-7d-utilization", "0.9"),
        ]),
        NOW,
    )
    .unwrap();
    assert_eq!(reading.windows.len(), 2);
    assert_eq!(reading.windows[0].id, "tokens-5-hour");
    assert_eq!(reading.windows[0].used_percent, 25.0);
    assert_eq!(reading.windows[0].resets_at_ms, Some(1_790_003_600_000));
    assert_eq!(reading.windows[1].id, "tokens-weekly");
    assert_eq!(reading.windows[1].used_percent, 90.0);
    assert_eq!(reading.windows[1].resets_at_ms, None);
}

pub(crate) fn absent_or_malformed_headers_yield_nothing() {
    for pairs in [
        &[][..],
        &[("x-codex-primary-used-percent", "n/a")][..],
        &[("x-codex-primary-used-percent", "-3")][..],
        &[("x-ratelimit-remaining-requests", "10")][..],
    ] {
        assert_eq!(parse_quota_headers("openai", &headers(pairs), NOW), None);
    }
    let odd = parse_quota_headers(
        "openai",
        &headers(&[
            ("x-codex-primary-used-percent", "150"),
            ("x-codex-primary-window-minutes", "60"),
        ]),
        NOW,
    )
    .unwrap();
    assert_eq!(odd.windows[0].id, "tokens-primary");
    assert_eq!(odd.windows[0].used_percent, 100.0);
}

/// Format pin: the Codex and Anthropic unified quota headers.
// test-category: format-pin
#[test]
fn response_headers_parse() {
    codex_windows_parse_used_percent_duration_and_reset();
    codex_zero_minute_window_is_absent_and_the_relative_reset_wins();
    anthropic_unified_utilization_is_a_fraction();
    absent_or_malformed_headers_yield_nothing();
}

/// Format pin: the `wham/usage` and `quota/limit` bodies, their lenient
/// variants, and the replies that are errors.
// test-category: format-pin
#[test]
fn usage_endpoint_bodies_parse() {
    use super::{codex_usage::tests as codex, zai_usage::tests as zai};
    codex::primary_and_secondary_windows_and_the_plan_parse();
    codex::camel_case_minutes_strings_and_resets_at_are_accepted();
    codex::additional_limits_merge_and_a_disallowed_limit_is_fully_used();
    codex::a_zero_length_window_is_absent_and_values_are_clamped();
    codex::a_body_without_windows_or_plan_is_a_schema_mismatch();
    zai::token_and_tool_windows_parse_with_resets_and_the_level();
    zai::credit_limits_count_as_model_quota_and_counts_give_the_percentage();
    zai::undocumented_windows_are_skipped_not_guessed();
    zai::rejected_keys_refusals_and_foreign_bodies_are_errors();
    zai::the_plan_name_is_sanitized();
    zai::the_credit_limit_example_parses_like_token_limits();
}
