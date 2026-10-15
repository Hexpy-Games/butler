//! `wham/usage` parsing: the openai/codex payload shape and its lenient
//! variants.

use serde_json::json;

use super::*;

const NOW: i64 = 1_790_000_000_000;

fn parse(value: &serde_json::Value) -> Result<ProviderQuotaReading, QuotaFetchError> {
    parse_codex_usage("openai", value.to_string().as_bytes(), NOW)
}

fn window(id: &str, used: f64, minutes: u64, resets_at_ms: i64) -> ProviderQuotaWindow {
    ProviderQuotaWindow {
        id: id.into(),
        used_percent: used,
        window_minutes: Some(minutes),
        resets_at_ms: Some(resets_at_ms),
    }
}

pub(crate) fn primary_and_secondary_windows_and_the_plan_parse() {
    let reading = parse(&json!({
        "plan_type": "pro",
        "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": {
                "used_percent": 12, "limit_window_seconds": 18_000,
                "reset_after_seconds": 600, "reset_at": 1_790_000_600
            },
            "secondary_window": {
                "used_percent": 40, "limit_window_seconds": 604_800,
                "reset_after_seconds": 90000, "reset_at": 1_790_090_000
            }
        },
        "credits": {"has_credits": false, "unlimited": false, "balance": null},
        "additional_rate_limits": null
    }))
    .unwrap();
    assert_eq!(reading.plan_name.as_deref(), Some("pro"));
    assert_eq!(reading.source, ProviderQuotaSource::UsageEndpoint);
    assert_eq!(reading.observed_at_ms, NOW);
    assert_eq!(
        reading.windows,
        vec![
            window("tokens-5-hour", 12.0, 300, 1_790_000_600_000),
            window("tokens-weekly", 40.0, 10_080, 1_790_090_000_000),
        ]
    );
}

pub(crate) fn camel_case_minutes_strings_and_resets_at_are_accepted() {
    let reading = parse(&json!({
        "planType": "plus",
        "rateLimit": {
            "primaryWindow": {
                "usedPercent": "7.5", "limitWindowMinutes": 300, "resetsAt": 1_790_000_600_000_i64
            },
            "secondaryWindow": {"usedPercent": 1, "windowMinutes": 10_080, "resetAfterSeconds": 60}
        }
    }))
    .unwrap();
    assert_eq!(
        reading.windows,
        vec![
            window("tokens-5-hour", 7.5, 300, 1_790_000_600_000),
            window("tokens-weekly", 1.0, 10_080, NOW + 60_000),
        ]
    );
}

pub(crate) fn additional_limits_merge_and_a_disallowed_limit_is_fully_used() {
    let reading = parse(&json!({
        "plan_type": "plus",
        "rate_limit": {
            "allowed": true,
            "primary_window": {"used_percent": 10, "limit_window_seconds": 18_000, "reset_at": 1_790_000_600},
            "secondary_window": {"used_percent": 20, "limit_window_seconds": 604_800, "reset_at": 1_790_090_000}
        },
        "additional_rate_limits": [
            {
                "limit_name": "other", "metered_feature": "codex_other",
                "rate_limit": {
                    "allowed": true,
                    "primary_window": {"used_percent": 55, "limit_window_seconds": 18_000, "reset_at": 1_790_000_900}
                }
            },
            {
                "limit_name": "blocked", "metered_feature": "codex_blocked",
                "rate_limit": {
                    "allowed": false,
                    "secondary_window": {"used_percent": 30, "limit_window_seconds": 604_800, "reset_at": 1_790_095_000}
                }
            }
        ]
    }))
    .unwrap();
    assert_eq!(
        reading.windows,
        vec![
            window("tokens-5-hour", 55.0, 300, 1_790_000_900_000),
            window("tokens-weekly", 100.0, 10_080, 1_790_095_000_000),
        ]
    );
}

pub(crate) fn a_zero_length_window_is_absent_and_values_are_clamped() {
    let reading = parse(&json!({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {"used_percent": 140, "limit_window_seconds": 604_800, "reset_after_seconds": 5},
            "secondary_window": {"used_percent": 0, "limit_window_seconds": 0, "reset_after_seconds": 0}
        }
    }))
    .unwrap();
    assert_eq!(
        reading.windows,
        vec![window("tokens-weekly", 100.0, 10_080, NOW + 5_000)]
    );
}

pub(crate) fn a_body_without_windows_or_plan_is_a_schema_mismatch() {
    for body in [
        json!({}),
        json!({"rate_limit": null}),
        json!({"rate_limit": {"primary_window": {"limit_window_seconds": 18_000}}}),
        json!([1, 2]),
    ] {
        assert!(
            matches!(parse(&body), Err(QuotaFetchError::Schema)),
            "{body}"
        );
    }
    assert!(matches!(
        parse_codex_usage("openai", b"<html>", NOW),
        Err(QuotaFetchError::Schema)
    ));
    // A plan without limits is a valid reading with no windows.
    let reading = parse(&json!({"plan_type": "enterprise", "rate_limit": null})).unwrap();
    assert_eq!(
        reading.windows,
        [] as [crate::models::quota::ProviderQuotaWindow; 0]
    );
}
