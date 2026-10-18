//! USE — remaining subscription quota polled from the providers' usage
//! endpoints (#241 follow-up): Codex `wham/usage` and the Z.AI Coding Plan
//! `quota/limit`, a rejected token's refresh, the failure views and the
//! views before any reading.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::config::nonempty;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::{Value, json};

/// Recorded reset times are `{{EPOCH_MS+Δ}}` / `{{EPOCH_S+Δ}}`, relative to
/// the replay; a view's reset must land that far after its fetch.
const RESET_TOLERANCE_MS: i64 = 120_000;

/// The recorded JSON body of `scenario`'s exchange for `path`.
fn recorded_body(scenario: &str, path: &str) -> Result<Value, HarnessError> {
    let cassette = Cassette::load(scenario)?;
    let exchange = cassette
        .exchanges
        .iter()
        .find(|exchange| exchange.request.path == path)
        .expect("the cassette records the path");
    assert_eq!(exchange.response.status, 200, "{scenario} {path}");
    Ok(serde_json::from_str(&exchange.response.body()).expect("the recording is JSON"))
}

/// Milliseconds from now of a recorded relative reset placeholder.
fn recorded_delta_ms(value: &Value) -> i64 {
    let text = value.as_str().expect("a relative reset placeholder");
    let (unit, delta) = text
        .strip_prefix("{{EPOCH_")
        .and_then(|rest| rest.strip_suffix("}}"))
        .and_then(|rest| rest.split_at_checked(rest.find(['+', '-'])?))
        .expect("{{EPOCH_<unit><delta>}}");
    let delta: i64 = delta.parse().unwrap();
    if unit == "MS" { delta } else { delta * 1000 }
}

fn epoch_ms(iso: &Value) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso.as_str().unwrap())
        .unwrap()
        .timestamp_millis()
}

/// The window resets `delta_ms` after the view's fetch.
fn assert_resets_after(view: &Value, window: &Value, delta_ms: i64) {
    let after = epoch_ms(&window["resetsAt"]) - epoch_ms(&view["fetchedAt"]);
    assert!(
        (after - delta_ms).abs() <= RESET_TOLERANCE_MS,
        "resets {after} ms after the fetch, recorded {delta_ms}: {window}"
    );
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
            json!({"provider_id": "zai", "model_id": "glm-5.3", "auth_type": "api_key", "api_key": key}),
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
        let body = recorded_body("USE-04", "/api/monitor/usage/quota/limit")?;
        assert_eq!(view["planName"], body["data"]["level"], "{view}");
        let limits = body["data"]["limits"].as_array().unwrap();
        for (id, unit, minutes) in [
            ("tokens-5-hour", 3, Some(300)),
            ("tokens-weekly", 6, Some(10_080)),
        ] {
            let limit = limits.iter().find(|limit| limit["unit"] == unit).unwrap();
            let window = windows.iter().find(|window| window["id"] == id).unwrap();
            assert_eq!(window["usedPercent"], limit["percentage"].as_f64().unwrap());
            assert_eq!(window["windowDurationMins"], json!(minutes));
            match limit.get("nextResetTime") {
                Some(reset) => assert_resets_after(&view, window, recorded_delta_ms(reset)),
                None => assert!(window["resetsAt"].is_null(), "{window}"),
            }
        }
    }
    let zai_api = quota(&s, "provider_id=zai-api&refresh=1").await?;
    assert_reason(&zai_api, "provider_quota_not_offered", "api");
    s.finish().await
}

/// USE-06 — a fresh data folder: the polled providers have no data yet,
/// API-billed ones offer no quota, and nothing is fetched. A provider
/// switched off in the config (`providerQuota.<id>.polling: false`), or all
/// of them by `BUTLER_PROVIDER_QUOTA_POLLING=0`, is not offered.
#[tokio::test]
async fn use_06_fresh_data_folder_reports_pending_and_not_offered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("USE-06")?
        .fixture(Fixture::Empty)
        .quota_polling()
        .start()
        .await?;
    for provider in ["zai"] {
        let view = quota(&s, &format!("provider_id={provider}")).await?;
        assert_reason(&view, "provider_quota_pending", "unknown");
    }
    for provider in ["openai", "zai-api", "anthropic"] {
        let view = quota(&s, &format!("provider_id={provider}")).await?;
        assert_reason(&view, "provider_quota_not_offered", "api");
    }
    let local = quota(&s, "provider_id=local").await?;
    assert_reason(&local, "provider_quota_not_offered", "unknown");
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = fs::read(&config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    config["providerQuota"] = json!({"zai": {"polling": false}});
    fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
    let zai = quota(&s, "provider_id=zai&refresh=1").await?;
    assert_reason(&zai, "provider_quota_not_offered", "unknown");
    let openai = quota(&s, "provider_id=openai").await?;
    assert_reason(&openai, "provider_quota_not_offered", "api");
    s.finish().await?;

    // The harness default: `BUTLER_PROVIDER_QUOTA_POLLING=0`.
    let off = Setup::new("USE-06-OFF")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    for provider in ["zai"] {
        let view = quota(&off, &format!("provider_id={provider}&refresh=1")).await?;
        assert_reason(&view, "provider_quota_not_offered", "unknown");
    }
    off.finish().await
}
