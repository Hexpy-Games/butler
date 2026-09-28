//! USE — subscription quota, conversation usage and estimated cost (#241).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::Setup;
use serde_json::Value;

const PROMPT: &str = "Reply with exactly one word: ready";

/// `x-codex-primary-used-percent` of the recorded reply.
fn recorded_primary_used_percent(cassette: &str) -> Result<f64, HarnessError> {
    let cassette = Cassette::load(cassette)?;
    let used = cassette
        .exchanges
        .iter()
        .flat_map(|exchange| &exchange.response.headers)
        .find(|(name, _)| name == "x-codex-primary-used-percent")
        .and_then(|(_, value)| value.parse::<f64>().ok());
    Ok(used.expect("the recorded reply carries x-codex-primary-used-percent"))
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

/// The provider's quota view is available and each window's shares add up.
fn assert_quota(remaining: &Value, primary_used: f64) {
    assert_eq!(remaining["available"], true, "{remaining}");
    assert_eq!(remaining["planKind"], "subscription", "{remaining}");
    assert_eq!(remaining["sourceKind"], "provider_quota", "{remaining}");
    assert!(remaining["reason"].is_null(), "{remaining}");
    let windows = remaining["windows"].as_array().unwrap();
    assert!(!windows.is_empty(), "{remaining}");
    for window in windows {
        let used = number(&window["usedPercent"]);
        let left = number(&window["remainingPercent"]);
        assert!((used + left - 100.0).abs() < 1e-9, "{window}");
        assert!(number(&window["windowDurationMins"]) > 0.0, "{window}");
        assert!(window["resetsAt"].is_string(), "{window}");
    }
    assert!(
        (number(&windows[0]["usedPercent"]) - primary_used).abs() < 1e-9,
        "primary window != recorded header: {remaining}"
    );
}

/// The session's cost is the gpt-6-luna list price of its own tokens.
fn assert_session_usage(usage: &Value) {
    let input = number(&usage["input_tokens"]);
    let cached = number(&usage["cached_input_tokens"]);
    let output = number(&usage["output_tokens"]);
    assert!(input > 0.0 && output > 0.0, "{usage}");
    assert!(number(&usage["request_count"]) >= 1.0, "{usage}");
    assert!(usage["reasoning_tokens"].is_number(), "{usage}");
    assert!(usage["updated_at"].is_string(), "{usage}");
    let cost = &usage["cost"];
    assert_eq!(cost["available"], true, "{usage}");
    assert!(cost["reason"].is_null(), "{usage}");
    assert_eq!(
        cost["priced_model_refs"],
        serde_json::json!(["openai/gpt-6-luna"])
    );
    // gpt-6-luna: $0.10 input, $0.01 cached input, $0.50 output per MTok.
    let expected = ((input - cached) * 0.10 + cached * 0.01 + output * 0.50) / 1e6;
    assert!(
        (number(&cost["usd"]) - expected).abs() < 1e-12,
        "{usage} expected {expected}"
    );
}

/// USE-01 — a subscription turn reports the plan quota from the reply's
/// `x-codex-*` headers (`/provider-quota`, `/usage-monitor`, a live
/// `provider_quota_updated` event, kept across restart) and the
/// conversation's tokens and list-price estimate on `SessionView.usage`.
#[tokio::test]
async fn use_01_subscription_turn_reports_quota_usage_and_cost() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("USE-01")?.cassette("USE-01").start().await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (_, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let primary_used = recorded_primary_used_percent("USE-01")?;

    let quota = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(quota.status, 200, "{}", quota.text);
    assert_quota(quota.data(), primary_used);
    let event = live
        .wait_for(Duration::from_secs(10), |event| {
            event["type"] == "provider_quota_updated" && event["payload"]["provider_id"] == "openai"
        })
        .await?;
    assert_quota(&event["payload"]["remaining"], primary_used);
    let missing = s.gw.get("/provider-quota").await?;
    assert_eq!(missing.status, 400, "{}", missing.text);

    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_session_usage(&view.data()["usage"]);
    assert_eq!(view.data()["context"]["auth_mode"], "subscription");

    let monitor = s.gw.get("/usage-monitor?since_hours=1").await?;
    assert_eq!(monitor.status, 200, "{}", monitor.text);
    let cost = &monitor.data()["cost"];
    assert_eq!(cost["available"], true, "{cost}");
    assert!(number(&cost["estimatedUsd"]) > 0.0, "{cost}");
    assert_eq!(cost["asOf"], "2026-09-28", "{cost}");
    let providers = monitor.data()["providerUsage"]["providers"]
        .as_array()
        .unwrap();
    let openai = providers
        .iter()
        .find(|provider| provider["providerId"] == "openai")
        .expect("openai usage bucket");
    assert_quota(&openai["remaining"], primary_used);

    s.restart().await?;
    let quota = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(quota.status, 200, "{}", quota.text);
    assert_eq!(quota.data()["available"], true, "{}", quota.text);
    s.finish().await
}
