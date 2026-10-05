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
use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::config::{Credential, LiveProvider, nonempty};
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::faults::{Fault, Transform};
use butler_e2e::e2e::scenario::{Fixture, STUB_REFRESH_TOKEN, Scenario, Setup};
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

/// The `wham/usage` view matches the recorded plan and main windows.
fn assert_codex_view(view: &Value, body: &Value) {
    assert_eq!(view["planName"], body["plan_type"], "{view}");
    let limit = &body["rate_limit"];
    let recorded: Vec<&Value> = ["primary_window", "secondary_window"]
        .iter()
        .map(|slot| &limit[*slot])
        .filter(|window| window["limit_window_seconds"].as_u64().unwrap_or(0) > 0)
        .collect();
    let windows = view["windows"].as_array().unwrap();
    assert_eq!(windows.len(), recorded.len(), "{view}");
    for (window, recorded) in windows.iter().zip(recorded) {
        let seconds = recorded["limit_window_seconds"].as_u64().unwrap();
        let id = match seconds {
            18_000 => "tokens-5-hour",
            604_800 => "tokens-weekly",
            _ => panic!("unpinned window length {seconds}"),
        };
        let used = recorded["used_percent"].as_f64().unwrap();
        assert_eq!(window["id"], id, "{window}");
        assert_eq!(window["usedPercent"], used, "{window}");
        assert_eq!(window["remainingPercent"], 100.0 - used, "{window}");
        assert_eq!(
            window["windowDurationMins"],
            seconds.div_ceil(60),
            "{window}"
        );
        assert_resets_after(view, window, recorded_delta_ms(&recorded["reset_at"]));
    }
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
    let view = quota(&s, "provider_id=openai&refresh=1").await?;
    assert_fresh(&view, "provider_quota", "openai-usage-endpoint");
    assert!(!view["windows"].as_array().unwrap().is_empty(), "{view}");
    if !s.recording() {
        assert_codex_view(&view, &recorded_body("USE-02", "/wham/usage")?);
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

/// While recording USE-05 the owner's test login is made to expire (as
/// LIVE-10 does), so the agent refreshes it through the recorder; the
/// refreshed login is written back to the same profile. Returns the
/// profile path and its original `expiresAt`.
fn expire_test_login() -> Result<(std::path::PathBuf, Value), HarnessError> {
    let Some(Credential::CodexProfile(path)) = LiveProvider::from_env().credential else {
        panic!("recording USE-05 needs the Butler test login (~/.butler-e2e-auth)");
    };
    let mut profile: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let original = profile["expiresAt"].clone();
    profile["expiresAt"] = json!(1);
    fs::write(&path, serde_json::to_vec_pretty(&profile)?)?;
    Ok((path, original))
}

/// Puts `expiresAt` back when the agent did not refresh the login.
fn restore_test_login(path: &std::path::Path, original: Value) -> Result<(), HarnessError> {
    let mut profile: Value = serde_json::from_slice(&fs::read(path)?)?;
    if profile["expiresAt"].as_f64().unwrap_or(0.0) <= 1.0 {
        profile["expiresAt"] = original;
        fs::write(path, serde_json::to_vec_pretty(&profile)?)?;
    }
    Ok(())
}

/// USE-05 — the usage endpoint rejects the login's token (the real Codex
/// 401 reply): the agent refreshes the login once through the token
/// endpoint and retries with the renewed token. A second rejection within
/// 10 minutes gets no refresh: the last reading stays, stale with
/// `provider_quota_fetch_failed` and none of the provider's error text, and
/// a refresh within 20 s of the last poll sends nothing. (No 429 reply has
/// been recorded; the rate-limit backoff is pinned by the poller's tests.)
#[tokio::test]
async fn use_05_rejected_token_is_refreshed_then_left_stale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("USE-05")?
        .cassette("USE-05")
        .quota_polling()
        .codex_login_refresh();
    let profile = setup.sandbox.root.join("codex-profile.json");
    let recording = butler_e2e::e2e::config::flag("BUTLER_E2E_RECORD");
    let expired = if recording {
        Some(expire_test_login()?)
    } else {
        None
    };
    let outcome = async {
        let s = setup.start().await?;
        if s.recording() {
            let view = quota(&s, "provider_id=openai&refresh=1").await?;
            assert_fresh(&view, "provider_quota", "openai-usage-endpoint");
            return s.finish().await;
        }
        rejected_then_stale(s, &profile).await
    }
    .await;
    if let Some((path, original)) = expired {
        restore_test_login(&path, original)?;
    }
    outcome
}

async fn rejected_then_stale(s: Scenario, profile: &std::path::Path) -> Result<(), HarnessError> {
    let usage = Cassette::load("USE-05")?
        .exchanges
        .iter()
        .position(|exchange| exchange.request.path == "/wham/usage")
        .unwrap();
    let rejected = || Fault::once(usage, Transform::ErrorFromLibrary("codex-401".into()));
    s.provider()?.inject(rejected())?;
    let served = s.provider()?.served();
    let fresh = quota(&s, "provider_id=openai&refresh=1").await?;
    assert_fresh(&fresh, "provider_quota", "openai-usage-endpoint");
    assert_codex_view(&fresh, &recorded_body("USE-05", "/wham/usage")?);
    assert_eq!(
        s.provider()?.served(),
        served + 3,
        "401, token refresh, retry"
    );
    let login: Value = serde_json::from_slice(&fs::read(profile)?)?;
    assert_ne!(login["accessToken"], "e2e-replay-placeholder", "{login}");
    assert_ne!(login["refreshToken"], STUB_REFRESH_TOKEN, "{login}");

    tokio::time::sleep(Duration::from_secs(21)).await;
    s.provider()?.inject(rejected())?;
    let served = s.provider()?.served();
    let reply =
        s.gw.get("/provider-quota?provider_id=openai&refresh=1")
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let failed = reply.data().clone();
    assert_eq!(s.provider()?.served(), served + 1, "no second refresh");
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
    assert_eq!(s.provider()?.served(), served + 1, "spaced 20 s apart");
    assert_eq!(again, failed);
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
    assert_reason(&openai, "provider_quota_pending", "unknown");
    s.finish().await?;

    // The harness default: `BUTLER_PROVIDER_QUOTA_POLLING=0`.
    let off = Setup::new("USE-06-OFF")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    for provider in ["openai", "zai"] {
        let view = quota(&off, &format!("provider_id={provider}&refresh=1")).await?;
        assert_reason(&view, "provider_quota_not_offered", "unknown");
    }
    off.finish().await
}
