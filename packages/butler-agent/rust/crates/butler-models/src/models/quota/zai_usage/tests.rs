//! Z.AI Coding Plan quota parsing (ported from the archived TypeScript
//! adapter's tests, plus `CREDIT_LIMIT` and count-derived percentages).

use serde_json::json;

use super::*;

const NOW: i64 = 1_790_000_000_000;

fn parse(value: &serde_json::Value) -> Result<ProviderQuotaReading, QuotaFetchError> {
    parse_zai_quota("zai", value.to_string().as_bytes(), NOW)
}

fn ids(reading: &ProviderQuotaReading) -> Vec<&str> {
    reading
        .windows
        .iter()
        .map(|window| window.id.as_str())
        .collect()
}

pub(crate) fn token_and_tool_windows_parse_with_resets_and_the_level() {
    let reading = parse(&json!({
        "code": 200, "msg": "Operation successful", "success": true,
        "data": {
            "level": "pro",
            "limits": [
                {"type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 100, "currentValue": 12,
                 "remaining": 88, "percentage": 12, "nextResetTime": 1_800_000_000_000_i64,
                 "usageDetails": [{"modelCode": "search-prime", "usage": 12}]},
                {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 37,
                 "nextResetTime": 1_790_000_600_000_i64},
                {"type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 140,
                 "nextResetTime": 1_790_090_000_000_i64}
            ]
        }
    }))
    .unwrap();
    assert_eq!(reading.plan_name.as_deref(), Some("pro"));
    assert_eq!(reading.source, ProviderQuotaSource::UsageEndpoint);
    assert_eq!(
        ids(&reading),
        ["tokens-5-hour", "tokens-weekly", "mcp-month"]
    );
    let five = &reading.windows[0];
    assert_eq!(five.used_percent, 37.0);
    assert_eq!(five.window_minutes, Some(300));
    assert_eq!(five.resets_at_ms, Some(1_790_000_600_000));
    assert_eq!(reading.windows[1].used_percent, 100.0);
    assert_eq!(reading.windows[1].window_minutes, Some(10_080));
    assert_eq!(reading.windows[2].used_percent, 12.0);
    assert_eq!(reading.windows[2].window_minutes, None);
}

pub(crate) fn credit_limits_count_as_model_quota_and_counts_give_the_percentage() {
    let reading = parse(&json!({
        "success": true,
        "data": {
            "level": "max",
            "limits": [
                {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 400, "currentValue": 100},
                {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 1000, "remaining": 250},
                {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 10}
            ]
        }
    }))
    .unwrap();
    assert_eq!(
        ids(&reading),
        ["tokens-5-hour", "tokens-weekly", "tokens-5-hour-2"]
    );
    assert_eq!(reading.windows[0].used_percent, 25.0);
    assert_eq!(reading.windows[1].used_percent, 75.0);
    assert_eq!(reading.windows[2].used_percent, 10.0);
}

pub(crate) fn undocumented_windows_are_skipped_not_guessed() {
    let reading = parse(&json!({
        "data": {
            "level": "lite",
            "limits": [
                {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 25, "nextResetTime": 1_790_000_600},
                {"type": "TOKENS_LIMIT", "unit": 99, "number": 1, "percentage": 30},
                {"type": "TIME_LIMIT", "unit": 7, "number": 1, "percentage": 10},
                {"type": "SOMETHING_NEW", "unit": 3, "number": 5, "percentage": 10}
            ]
        }
    }))
    .unwrap();
    assert_eq!(ids(&reading), ["tokens-5-hour"]);
    // A reset sent in seconds is read as seconds.
    assert_eq!(reading.windows[0].resets_at_ms, Some(1_790_000_600_000));
}

pub(crate) fn rejected_keys_refusals_and_foreign_bodies_are_errors() {
    assert!(matches!(
        parse(&json!({"code": 401, "msg": "token expired", "success": false})),
        Err(QuotaFetchError::Unauthorized { status: 401 })
    ));
    assert!(matches!(
        parse(&json!({"code": 1001, "msg": "invalid", "success": false})),
        Err(QuotaFetchError::Unauthorized { status: 1001 })
    ));
    // An auth code is a rejection even when `success` is not false.
    assert!(matches!(
        parse(&json!({"code": 1002, "msg": "invalid", "success": true, "data": {"limits": []}})),
        Err(QuotaFetchError::Unauthorized { status: 1002 })
    ));
    assert!(matches!(
        parse(&json!({"code": 500, "msg": "busy", "success": false})),
        Err(QuotaFetchError::Refused)
    ));
    for body in [
        json!({"success": true}),
        json!({"data": {"limits": []}}),
        json!({"data": {"limits": [{"type": "TOKENS_LIMIT", "unit": 3, "number": 5}]}}),
    ] {
        assert!(
            matches!(parse(&body), Err(QuotaFetchError::Schema)),
            "{body}"
        );
    }
    // A tool-only or level-only reply is a reading, not a failure.
    let tools = parse(&json!({"data": {"limits": [
        {"type": "TIME_LIMIT", "unit": 5, "number": 1, "percentage": 1}
    ]}}))
    .unwrap();
    assert_eq!(ids(&tools), ["mcp-month"]);
    let level = parse(&json!({"data": {"level": "pro", "limits": []}})).unwrap();
    assert!(level.windows.is_empty());
    assert_eq!(level.plan_name.as_deref(), Some("pro"));
}

pub(crate) fn the_plan_name_is_sanitized() {
    let reading = parse(&json!({
        "data": {
            "level": "<b>Pro</b>\u{202e}",
            "limits": [{"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 1}]
        }
    }))
    .unwrap();
    assert_eq!(reading.plan_name.as_deref(), Some("bProb"));
}

/// The `CREDIT_LIMIT` shape, synthesized from the official client's
/// documentation (not a recording: the live account returns
/// `TOKENS_LIMIT`; see the fixture's `_provenance`).
pub(crate) fn the_credit_limit_example_parses_like_token_limits() {
    let body = include_str!("credit-limit.example.json");
    let example: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        example["_provenance"]["source"],
        "synthesized-from-official-client (zai-org/ZCode), unverified-live"
    );
    let reading = parse_zai_quota("zai", body.as_bytes(), NOW).unwrap();
    assert_eq!(reading.plan_name.as_deref(), Some("lite"));
    assert_eq!(
        ids(&reading),
        ["tokens-5-hour", "tokens-weekly", "mcp-month"]
    );
    assert_eq!(reading.windows[0].used_percent, 25.0);
    assert_eq!(reading.windows[0].resets_at_ms, Some(1_790_018_000_000));
    assert_eq!(reading.windows[1].used_percent, 10.0);
    assert_eq!(reading.windows[2].used_percent, 3.0);
}
