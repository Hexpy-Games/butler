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
use serde_json::{Value, json};

const PROMPT: &str = "Reply with exactly one word: ready";

/// What the USE-01 recording reported: its `response.completed` usage and
/// its `x-codex-primary-*` headers.
struct Recorded {
    input: u64,
    cached: u64,
    cache_write: u64,
    output: u64,
    reasoning: u64,
    primary_used_percent: f64,
    primary_window_minutes: u64,
}

fn recorded() -> Result<Recorded, HarnessError> {
    let cassette = Cassette::load("USE-01")?;
    let response = &cassette.exchanges[0].response;
    let header = |name: &str| {
        response
            .headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| panic!("the recording lacks {name}"))
    };
    let completed = response
        .body()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .find(|event| event["type"] == "response.completed")
        .expect("the recording completes");
    let usage = &completed["response"]["usage"];
    let count = |pointer: &str| usage.pointer(pointer).and_then(Value::as_u64).unwrap();
    Ok(Recorded {
        input: count("/input_tokens"),
        cached: count("/input_tokens_details/cached_tokens"),
        cache_write: count("/input_tokens_details/cache_write_tokens"),
        output: count("/output_tokens"),
        reasoning: count("/output_tokens_details/reasoning_tokens"),
        primary_used_percent: header("x-codex-primary-used-percent").parse().unwrap(),
        primary_window_minutes: header("x-codex-primary-window-minutes").parse().unwrap(),
    })
}

/// The quota view carries exactly the recorded weekly window (the recorded
/// secondary window is zero minutes long, so absent).
fn assert_quota(remaining: &Value, recorded: Option<&Recorded>) {
    assert_eq!(remaining["available"], true, "{remaining}");
    assert_eq!(remaining["stale"], false, "{remaining}");
    assert_eq!(remaining["planKind"], "subscription", "{remaining}");
    assert_eq!(remaining["sourceKind"], "provider_quota", "{remaining}");
    assert!(remaining["reason"].is_null(), "{remaining}");
    let windows = remaining["windows"].as_array().unwrap();
    assert!(windows.iter().all(|window| window["resetsAt"].is_string()));
    let Some(recorded) = recorded else {
        return;
    };
    assert_eq!(windows.len(), 1, "{remaining}");
    let window = &windows[0];
    assert_eq!(window["id"], "tokens-weekly", "{window}");
    assert_eq!(
        window["windowDurationMins"],
        recorded.primary_window_minutes
    );
    assert_eq!(window["usedPercent"], recorded.primary_used_percent);
    assert_eq!(
        window["remainingPercent"],
        100.0 - recorded.primary_used_percent
    );
}

/// The gpt-6-luna list price ($0.10 input, $0.01 cached, $0.125 cache write,
/// $0.50 output per MTok) of the recorded request.
fn recorded_cost(recorded: &Recorded) -> f64 {
    let uncached = recorded.input - recorded.cached - recorded.cache_write;
    (uncached as f64 * 0.10
        + recorded.cached as f64 * 0.01
        + recorded.cache_write as f64 * 0.125
        + recorded.output as f64 * 0.50)
        / 1e6
}

/// `SessionView.usage` holds exactly the recorded request and its price.
fn assert_session_usage(usage: &Value, recorded: &Recorded) {
    assert_eq!(usage["input_tokens"], recorded.input, "{usage}");
    assert_eq!(usage["cached_input_tokens"], recorded.cached, "{usage}");
    assert_eq!(usage["cache_write_tokens"], recorded.cache_write, "{usage}");
    assert_eq!(usage["output_tokens"], recorded.output, "{usage}");
    assert_eq!(usage["reasoning_tokens"], recorded.reasoning, "{usage}");
    assert_eq!(usage["request_count"], 1, "{usage}");
    assert!(usage["updated_at"].is_string(), "{usage}");
    let cost = &usage["cost"];
    assert_eq!(cost["available"], true, "{usage}");
    assert!(cost["reason"].is_null(), "{usage}");
    assert_eq!(cost["priced_model_refs"], json!(["openai/gpt-6-luna"]));
    let usd = cost["usd"].as_f64().unwrap();
    assert!((usd - recorded_cost(recorded)).abs() < 1e-15, "{usage}");
}

/// USE-01 — a subscription turn reports the plan quota from the reply's
/// `x-codex-*` headers (`/provider-quota`, `/usage-monitor`, a live
/// `provider_quota_updated` event, unchanged across restart) and the
/// conversation's tokens and list-price estimate on `SessionView.usage`.
#[tokio::test]
async fn use_01_subscription_turn_reports_quota_usage_and_cost() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("USE-01")?.cassette("USE-01").start().await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (_, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    // While recording, the cassette is written only at the end.
    let recorded = if s.recording() {
        None
    } else {
        Some(recorded()?)
    };
    if let Some(recorded) = &recorded {
        // The recorded reply this scenario pins.
        assert_eq!(
            (recorded.input, recorded.output, recorded.reasoning),
            (10_499, 5, 0)
        );
    }

    let quota = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(quota.status, 200, "{}", quota.text);
    assert_quota(quota.data(), recorded.as_ref());
    let event = live
        .wait_for(Duration::from_secs(10), |event| {
            event["type"] == "provider_quota_updated" && event["payload"]["provider_id"] == "openai"
        })
        .await?;
    assert_quota(&event["payload"]["remaining"], recorded.as_ref());
    let missing = s.gw.get("/provider-quota").await?;
    assert_eq!(missing.status, 400, "{}", missing.text);

    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    let usage = view.data()["usage"].clone();
    assert_eq!(view.data()["context"]["auth_mode"], "subscription");
    // A second read folds no new rows and changes nothing.
    let again = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(again.data()["usage"], usage);

    // A delivered chat precedes background extraction. Wait for its completed
    // usage row, rather than racing it or guessing a delay. The empty meaning
    // stub performs exactly one request and requires no further binding stages.
    let monitor = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let monitor = s.gw.get("/usage-monitor?since_hours=1").await?;
            if monitor.data()["model"]["byScopeUsage"]
                .as_object()
                .is_some_and(|scopes| {
                    scopes.iter().any(|(scope, tokens)| {
                        scope.starts_with("memory-extract:") && tokens["requestCount"] == 1
                    })
                })
            {
                return Ok::<_, HarnessError>(monitor);
            }
        }
    })
    .await
    .map_err(|_| {
        butler_e2e::e2e::harness_error("background extraction usage did not complete")
    })??;
    assert_eq!(monitor.status, 200, "{}", monitor.text);
    let cost = &monitor.data()["cost"];
    assert_eq!(cost["available"], true, "{cost}");
    assert_eq!(cost["asOf"], "2026-09-28", "{cost}");
    let providers = monitor.data()["providerUsage"]["providers"]
        .as_array()
        .unwrap();
    let openai = providers
        .iter()
        .find(|provider| provider["providerId"] == "openai")
        .expect("openai usage bucket");
    assert_quota(&openai["remaining"], recorded.as_ref());
    if let Some(recorded) = &recorded {
        assert_session_usage(&usage, recorded);
        assert_monitor_cost(monitor.data(), recorded);
        let session =
            s.gw.get("/usage-monitor?session_id=general&since_hours=1")
                .await?;
        let session_cost = &session.data()["cost"];
        assert_eq!(session.data()["model"]["requestCount"], 1);
        assert_eq!(session_cost["byWork"].as_object().unwrap().len(), 1);
        assert!(
            (session_cost["estimatedUsd"].as_f64().unwrap() - recorded_cost(recorded)).abs()
                < 1e-15,
            "{session_cost}"
        );
    }

    s.restart().await?;
    let after = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(after.status, 200, "{}", after.text);
    assert_eq!(after.data(), quota.data(), "quota changed across restart");
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["usage"], usage, "usage changed across restart");
    assert_eq!(view.data()["context"]["auth_mode"], "subscription");
    s.finish().await
}

/// The install total includes real background spend, itemized separately from conversation work.
fn assert_monitor_cost(monitor: &Value, recorded: &Recorded) {
    let work = monitor["cost"]["byWork"].as_object().unwrap();
    assert_eq!(work.len(), 2, "{monitor}");
    let conversation = &work["conversation"];
    assert_eq!(conversation["requestCount"], 1);
    assert_eq!(
        conversation["pricedModelRefs"],
        json!(["openai/gpt-6-luna"])
    );
    assert!(
        (conversation["estimatedUsd"].as_f64().unwrap() - recorded_cost(recorded)).abs() < 1e-15,
        "{conversation}"
    );
    let memory = &work["memory"];
    assert_eq!(memory["requestCount"], 1);
    let scopes = monitor["model"]["byScopeUsage"].as_object().unwrap();
    let (_, tokens) = scopes
        .iter()
        .find(|(scope, _)| scope.starts_with("memory-extract:"))
        .expect("background memory tokens");
    assert_eq!(tokens["requestCount"], 1, "{tokens}");
    assert_eq!(tokens["promptTokens"], 100.0, "{tokens}");
    assert_eq!(tokens["outputTokens"], 20.0, "{tokens}");
    assert_eq!(memory["pricedModelRefs"], json!(["gpt-6-luna"]));
    let background_usd = (100.0 * 0.10 + 20.0 * 0.50) / 1e6;
    assert!(
        (memory["estimatedUsd"].as_f64().unwrap() - background_usd).abs() < 1e-15,
        "{memory}"
    );
    assert_eq!(monitor["model"]["requestCount"], 2);
    assert!(
        (monitor["cost"]["estimatedUsd"].as_f64().unwrap()
            - recorded_cost(recorded)
            - background_usd)
            .abs()
            < 1e-15,
        "{monitor}"
    );
}
