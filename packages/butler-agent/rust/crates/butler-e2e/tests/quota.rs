//! USE — remaining subscription quota polled from the providers' usage
//! endpoints (#241 follow-up): Codex `wham/usage` and the Z.AI Coding Plan
//! `quota/limit`, their failure views and the views before any reading.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::config::nonempty;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::faults::{Fault, Transform};
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::{Value, json};

/// The recorded usage-endpoint body of `scenario` (its first exchange).
fn recorded_body(scenario: &str) -> Result<Value, HarnessError> {
    let cassette = Cassette::load(scenario)?;
    let response = &cassette.exchanges[0].response;
    assert_eq!(response.status, 200, "{scenario} records a successful read");
    Ok(serde_json::from_str(&response.body()).expect("the recording is JSON"))
}

/// RFC 3339 (milliseconds, UTC) of epoch milliseconds, as the product writes.
fn iso(epoch_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The windows a `wham/usage` body's main rate limit reports:
/// `(id, used %, minutes, resetsAt)`.
fn codex_windows(body: &Value) -> Vec<(String, f64, u64, String)> {
    let limit = &body["rate_limit"];
    ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|slot| {
            let window = &limit[slot];
            let seconds = window["limit_window_seconds"].as_u64()?;
            (seconds > 0).then(|| {
                let id = match seconds {
                    18_000 => "tokens-5-hour",
                    604_800 => "tokens-weekly",
                    _ => panic!("unpinned window length {seconds}"),
                };
                let used = if limit["allowed"] == false {
                    100.0
                } else {
                    window["used_percent"].as_f64().unwrap()
                };
                let reset = window["reset_at"].as_i64().unwrap() * 1000;
                (id.to_owned(), used, seconds.div_ceil(60), iso(reset))
            })
        })
        .collect()
}

fn assert_windows(view: &Value, expected: &[(String, f64, u64, String)]) {
    let windows = view["windows"].as_array().unwrap();
    assert_eq!(windows.len(), expected.len(), "{view}");
    for (window, (id, used, minutes, resets_at)) in windows.iter().zip(expected) {
        assert_eq!(window["id"], id.as_str(), "{window}");
        assert_eq!(window["usedPercent"], *used, "{window}");
        assert_eq!(window["remainingPercent"], 100.0 - used, "{window}");
        assert_eq!(window["windowDurationMins"], *minutes, "{window}");
        assert_eq!(window["resetsAt"], resets_at.as_str(), "{window}");
    }
}

/// A fresh polled reading: available, current, no reason.
fn assert_fresh(view: &Value, source_kind: &str, source_id: &str) {
    assert_eq!(view["available"], true, "{view}");
    assert_eq!(view["stale"], false, "{view}");
    assert!(view["reason"].is_null(), "{view}");
    assert_eq!(view["sourceKind"], source_kind, "{view}");
    assert_eq!(view["sourceId"], source_id, "{view}");
    assert_eq!(view["planKind"], "subscription", "{view}");
    assert!(view["fetchedAt"].is_string(), "{view}");
}

fn assert_reason(view: &Value, code: &str, plan_kind: &str) {
    assert_eq!(view["available"], false, "{view}");
    assert_eq!(view["reason"]["code"], code, "{view}");
    assert_eq!(view["planKind"], plan_kind, "{view}");
    assert_eq!(view["windows"], json!([]), "{view}");
}

async fn quota(s: &Scenario, query: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&format!("/provider-quota?{query}")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

/// USE-02 — `refresh=1` polls the Codex login's `wham/usage` (Butler's own
/// User-Agent, the login's bearer token and account id) and reports its
/// plan and windows, as a `provider_quota_updated` event too; without
/// `refresh` the stored reading answers with no new request, and it
/// survives a restart.
#[tokio::test]
async fn use_02_codex_usage_endpoint_reports_plan_and_windows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("USE-02")?
        .cassette("USE-02")
        .quota_polling()
        .start()
        .await?;
    let recorded = if s.recording() {
        None
    } else {
        Some(recorded_body("USE-02")?)
    };
    let view = quota(&s, "provider_id=openai&refresh=1").await?;
    assert_fresh(&view, "provider_quota", "openai-usage-endpoint");
    assert!(!view["windows"].as_array().unwrap().is_empty(), "{view}");
    if let Some(body) = &recorded {
        assert_eq!(view["planName"], body["plan_type"], "{view}");
        assert_windows(&view, &codex_windows(body));
    }
    // The event log replays from the start, so the event the poll published
    // is seen even though the subscription opens after it.
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let event = live
        .wait_for(Duration::from_secs(10), |event| {
            event["type"] == "provider_quota_updated" && event["payload"]["provider_id"] == "openai"
        })
        .await?;
    assert_eq!(event["payload"]["remaining"], view);
    drop(live);

    let served = s.provider()?.served();
    assert_eq!(quota(&s, "provider_id=openai").await?, view);
    let monitor = s.gw.get("/usage-monitor?since_hours=1").await?;
    let providers = monitor.data()["providerUsage"]["providers"].clone();
    let openai = providers
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["providerId"] == "openai")
        .expect("a provider with quota is listed without usage");
    assert_eq!(openai["remaining"], view);
    assert_eq!(
        s.provider()?.served(),
        served,
        "no poll inside the interval"
    );

    s.restart().await?;
    let after = quota(&s, "provider_id=openai").await?;
    assert_eq!(after["windows"], view["windows"]);
    assert_eq!(after["planName"], view["planName"]);
    s.finish().await
}

/// USE-04 — the Z.AI Coding Plan quota is read with the registered model's
/// key from the official quota endpoint (here the recorder standing in for
/// `api.z.ai`), with its level as the plan; the pay-as-you-go provider
/// offers no quota.
#[tokio::test]
async fn use_04_zai_coding_plan_quota_is_polled() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("USE-04")?
        .cassette("USE-04")
        .quota_polling()
        .start()
        .await?;
    // Recording reads the owner's key from the environment; replay needs
    // none (the recorder does not check it).
    let key = if s.recording() {
        nonempty("ZAI_API_KEY").expect("recording USE-04 needs ZAI_API_KEY")
    } else {
        "zai-e2e-replay-key".to_owned()
    };
    let registered = s
        .gw
        .post(
            "/model-catalog/registered-models",
            json!({"provider_id": "zai", "model_id": "glm-5.1", "auth_type": "api_key", "api_key": key}),
        )
        .await?;
    assert!(registered.status < 300, "{}", registered.status);
    assert!(!registered.text.contains(&key), "the key is never echoed");

    let view = quota(&s, "provider_id=zai&refresh=1").await?;
    assert_fresh(&view, "zai_usage_query", "zai-coding-plan-usage-query");
    let windows = view["windows"].as_array().unwrap();
    assert!(
        windows.iter().any(|window| window["id"] == "tokens-5-hour"),
        "{view}"
    );
    if !s.recording() {
        let body = recorded_body("USE-04")?;
        assert_eq!(view["planName"], body["data"]["level"], "{view}");
        let five_hour = body["data"]["limits"]
            .as_array()
            .unwrap()
            .iter()
            .find(|limit| limit["unit"] == 3 && limit["number"] == 5)
            .unwrap();
        let window = windows
            .iter()
            .find(|window| window["id"] == "tokens-5-hour")
            .unwrap();
        assert_eq!(
            window["usedPercent"],
            five_hour["percentage"].as_f64().unwrap()
        );
        assert_eq!(window["windowDurationMins"], 300);
        if let Some(reset) = five_hour["nextResetTime"].as_i64() {
            assert_eq!(window["resetsAt"], iso(reset).as_str());
        }
    }
    let zai_api = quota(&s, "provider_id=zai-api&refresh=1").await?;
    assert_reason(&zai_api, "provider_quota_not_offered", "api");
    s.finish().await
}

/// USE-05 — a rejected token (the real Codex 401 reply) after a good read:
/// one login refresh and retry, then the last reading stays, marked stale
/// with `provider_quota_fetch_failed` and none of the provider's error text;
/// the next on-demand poll reads fresh again. (No 429 reply has been
/// recorded; the rate-limit backoff is pinned by the poller's unit tests.)
#[tokio::test]
async fn use_05_rejected_poll_keeps_a_stale_reading() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("USE-05")?
        .cassette("USE-02")
        .replay_only()
        .quota_polling()
        .start()
        .await?;
    let fresh = quota(&s, "provider_id=openai&refresh=1").await?;
    assert_fresh(&fresh, "provider_quota", "openai-usage-endpoint");
    let served = s.provider()?.served();
    s.provider()?.inject(Fault::times(
        0,
        2,
        Transform::ErrorFromLibrary("codex-401".into()),
    ))?;
    let reply =
        s.gw.get("/provider-quota?provider_id=openai&refresh=1")
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let failed = reply.data();
    assert_eq!(s.provider()?.served(), served + 2, "one refresh and retry");
    assert_eq!(failed["available"], true, "{failed}");
    assert_eq!(failed["stale"], true, "{failed}");
    assert_eq!(failed["reason"]["code"], "provider_quota_fetch_failed");
    assert_eq!(failed["windows"], fresh["windows"]);
    assert_eq!(failed["fetchedAt"], fresh["fetchedAt"]);
    for raw in ["authentication token", "Could not parse", "detail"] {
        assert!(
            !reply.text.contains(raw),
            "raw error text {raw:?}: {}",
            reply.text
        );
    }
    let again = quota(&s, "provider_id=openai&refresh=1").await?;
    assert_fresh(&again, "provider_quota", "openai-usage-endpoint");
    assert_eq!(again["windows"], fresh["windows"]);
    s.finish().await
}

/// USE-06 — a fresh data folder: the polled providers have no data yet,
/// API-billed ones offer no quota, and nothing is fetched.
#[tokio::test]
async fn use_06_fresh_data_folder_reports_pending_and_not_offered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("USE-06")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    for provider in ["openai", "zai"] {
        let view = quota(&s, &format!("provider_id={provider}")).await?;
        assert_reason(&view, "provider_quota_pending", "unknown");
    }
    for provider in ["zai-api", "anthropic"] {
        let view = quota(&s, &format!("provider_id={provider}")).await?;
        assert_reason(&view, "provider_quota_not_offered", "api");
    }
    let local = quota(&s, "provider_id=local").await?;
    assert_reason(&local, "provider_quota_not_offered", "unknown");
    s.finish().await
}
