//! Plan limits use the existing generic quota failure path.
use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use butler_e2e::e2e::{gateway::turn_state, scenario::Setup};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Script { calls: usize }
async fn reply(State(state): State<Arc<Mutex<Script>>>) -> Response {
    state.lock().unwrap().calls += 1;
    (StatusCode::TOO_MANY_REQUESTS,
        Json(json!({"error":{"code":"subscription_sharing_usage_limit_exceeded"}})))
        .into_response()
}

#[tokio::test]
async fn siwc_19_quota_advances_to_configured_backup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_e2e::e2e::{
        events::LiveEvents,
        fake_servers::{ChatBehavior, FakeServer},
    };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let state = Arc::new(Mutex::new(Script::default()));
    let router = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let s = Setup::new("SIWC-19")?
        .env("BUTLER_CHATGPT_API_BASE_URL", base)
        .start()
        .await?;
    let renamed =
        s.gw.patch(
            "/sessions/general",
            json!({"title":"Quota fallback verification"}),
        )
        .await?;
    assert_eq!(renamed.status, 200, "{}", renamed.text);
    let backup = FakeServer::local_models(ChatBehavior::default()).await?;
    let registered = s.gw.post("/model-catalog/local-models",json!({"provider_id":"local","api_type":"openai_compatible","platform":"custom","server_url":backup.base_url,"model_id":"backup-model","display_name":"backup-model","context_window_tokens":131_072,"source":"manual"})).await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let backup_ref = registered.data()["model"]["model_ref"].clone();
    let reply =
        s.gw.patch(
            "/settings",
            json!({"model_fallback":{"enabled":true,"models":[backup_ref]}}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (_, turn) = s.turn("general", "quota fallback check").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(state.lock().unwrap().calls, 1);
    assert_ne!(backup.chat_requests(), [] as [Value; 0]);
    live.wait_for(std::time::Duration::from_secs(10), |event| {
        let text = event.to_string();
        text.contains("provider_quota_exhausted")
            && text.contains("chatgpt_oauth")
            && text.contains("model-fallback")
    })
    .await?;
    let view = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(view.data()["planUsage"]["state"], "limit_reached");
    s.finish().await?;
    task.abort();
    Ok(())
}
