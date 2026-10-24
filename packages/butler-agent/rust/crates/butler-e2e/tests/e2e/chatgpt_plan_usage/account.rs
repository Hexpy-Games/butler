//! Account changes discard prior-account estimates and confirmed plan limits.
use super::*;
use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::post};
use butler_e2e::e2e::{
    events::LiveEvents,
    fixtures,
    gateway::turn_state,
    scenario::{Scenario, Setup},
};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

async fn limited(State(reset): State<Arc<Mutex<i64>>>) -> impl IntoResponse {
    let reset = *reset.lock().unwrap();
    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            ("x-ratelimit-reset", (reset / 1_000).to_string()),
            ("x-codex-primary-used-percent", "100".into()),
            ("x-codex-primary-window-minutes", "300".into()),
        ],
        Json(json!({"error":{"code":"subscription_sharing_usage_limit_exceeded"}})),
    )
}

#[tokio::test]
async fn plan_limit_updates_and_account_changes_clear_saved_quota() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let reset = ((chrono::Utc::now().timestamp_millis() / 1_000) + 3_600) * 1_000;
    let state = Arc::new(Mutex::new(reset));
    let router = Router::new()
        .route("/v1/responses", post(limited))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let setup = Setup::new("SIWC-account-quota")?
        .without_credential()
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer)
        .env("BUTLER_CHATGPT_API_BASE_URL", base);
    fixtures::stub_chatgpt_auth(&setup.sandbox.data, &authority)?;
    let s = setup.start().await?;
    s.gw.patch(
        "/sessions/general",
        json!({"title":"Plan quota verification"}),
    )
    .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let path = s.sandbox.data.join("metrics/provider-quota.json");
    fail_turn(&s).await?;
    let first = persisted(&path, Some(reset)).await?;
    let modified = std::fs::metadata(&path)?.modified()?;
    fail_turn(&s).await?;
    assert_eq!(
        std::fs::read(&path)?,
        first,
        "identical limit does not rewrite quota"
    );
    assert_eq!(std::fs::metadata(&path)?.modified()?, modified);
    *state.lock().unwrap() = reset + 3_600_000;
    fail_turn(&s).await?;
    persisted(&path, Some(reset + 3_600_000)).await?;
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "provider_quota_updated"
            && event["payload"]["remaining"]["planUsage"]["resetsAt"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| at.timestamp_millis() == reset + 3_600_000)
    })
    .await?;
    let flow = start(&s, json!({"kind":"new_account"})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["status"], "completed");
    persisted(&path, None).await?;
    assert_clear(&s).await?;
    fail_turn(&s).await?;
    persisted(&path, Some(reset + 3_600_000)).await?;
    let result =
        s.gw.post("/setup/chatgpt-account/sign-out", json!({}))
            .await?;
    assert_eq!(result.data()["revoked"], true);
    let cleared = persisted(&path, None).await?;
    assert_clear(&s).await?;
    let modified = std::fs::metadata(&path)?.modified()?;
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["status"], "completed");
    assert_eq!(
        std::fs::read(&path)?,
        cleared,
        "empty account clear has no write"
    );
    assert_eq!(std::fs::metadata(&path)?.modified()?, modified);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn fail_turn(s: &Scenario) -> Result<(), HarnessError> {
    let (_, turn) = s.turn("general", "continue my conversation").await?;
    assert_eq!(turn_state(&turn), "failed");
    assert!(turn.to_string().contains("provider_quota_exhausted"));
    Ok(())
}
async fn assert_clear(s: &Scenario) -> Result<(), HarnessError> {
    let view = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(view.data()["windows"], json!([]));
    assert_ne!(view.data()["planUsage"]["state"], "limit_reached");
    Ok(())
}
async fn persisted(path: &Path, reset: Option<i64>) -> Result<Vec<u8>, HarnessError> {
    let deadline = SystemTime::now() + Duration::from_secs(10);
    loop {
        if let Ok(bytes) = std::fs::read(path) {
            let value: Value = serde_json::from_slice(&bytes)?;
            let limits = &value["plan_limit"];
            let matches = match reset {
                Some(at) => {
                    limits["openai"]["resets_at_ms"] == at
                        && value["providers"]["openai"].is_object()
                }
                None => {
                    limits.as_object().is_some_and(serde_json::Map::is_empty)
                        && value["providers"]
                            .as_object()
                            .is_some_and(serde_json::Map::is_empty)
                }
            };
            if matches {
                return Ok(bytes);
            }
        }
        if SystemTime::now() > deadline {
            return Err(HarnessError("quota transition was not persisted".into()));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
