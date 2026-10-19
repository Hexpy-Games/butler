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
enum Terminal {
    #[default]
    Limit,
    Completed,
}
#[derive(Default)]
struct Script {
    stream: bool,
    reset: bool,
    terminal: Terminal,
    calls: usize,
    shapes: Vec<(bool, bool)>,
    paths: Vec<String>,
    headers: bool,
}
async fn reply(State(state): State<Arc<Mutex<Script>>>, Json(body): Json<Value>) -> Response {
    let mut state = state.lock().unwrap();
    state.calls += 1;
    state.shapes.push((
        butler_e2e::e2e::provider::is_title_request(&body),
        !butler_e2e::e2e::chatgpt_wire::function_paths(&body).is_empty(),
    ));
    if matches!(state.terminal, Terminal::Completed) {
        let mut response = ([("content-type", "text/event-stream")], format!("data: {}\n\n", json!({"type":"response.completed","response":{"id":"usage-ok","model":"gpt-6-luna","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ready"}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}))).into_response();
        if state.headers {
            for (key, value) in [
                ("x-codex-primary-used-percent", "25"),
                ("x-codex-primary-window-minutes", "300"),
                ("x-codex-credits-balance", "12.5"),
            ] {
                response.headers_mut().insert(key, value.parse().unwrap());
            }
        }
        return response;
    }
    let error = json!({"code":"subscription_sharing_usage_limit_exceeded"});
    let mut response = if state.stream {
        (
            [("content-type", "text/event-stream")],
            format!(
                "data: {}\n\n",
                json!({"type":"response.failed","response":{"error":error}})
            ),
        )
            .into_response()
    } else {
        (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":error}))).into_response()
    };
    response
        .headers_mut()
        .insert("x-oai-request-id", "plan-limit-request".parse().unwrap());
    if state.reset {
        response
            .headers_mut()
            .insert("retry-after", "600".parse().unwrap());
    }
    response
}

#[tokio::test]
async fn siwc_11_quota_limit_and_success_transitions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (stream, reset) in [(false, true), (true, false)] {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}/v1", listener.local_addr()?);
        let state = Arc::new(Mutex::new(Script {
            stream,
            reset,
            ..Default::default()
        }));
        let router = Router::new()
            .route("/v1/responses", post(reply))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                record_paths,
            ));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let s = Setup::new("SIWC-11")?
            .env("BUTLER_CHATGPT_API_BASE_URL", &base)
            .start()
            .await?;
        let renamed =
            s.gw.patch("/sessions/general", json!({"title":"Quota verification"}))
                .await?;
        assert_eq!(renamed.status, 200, "{}", renamed.text);
        s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
            .await?;
        let (_, turn) = s.turn("general", "plan limit check").await?;
        assert_eq!(turn_state(&turn), "failed", "{turn}");
        assert!(
            turn.to_string().contains("provider_quota_exhausted"),
            "{turn}"
        );
        {
            let observed = state.lock().unwrap();
            assert_eq!(
                observed.calls, 1,
                "stream={stream}, shapes={:?}",
                observed.shapes
            );
            assert!(observed.shapes.iter().all(|(title, _)| !title));
        }
        let messages = s.gw.messages("general").await?;
        let answer = messages
            .iter()
            .find(|message| message["role"] == "assistant" && message["turn_id"] == turn["id"])
            .unwrap();
        assert_eq!(
            answer["text"],
            "The model provider's exhausted quota prevented further work. Progress is saved."
        );
        let view = s.gw.get("/provider-quota?provider_id=openai").await?;
        assert_eq!(
            view.data()["planUsage"]["state"],
            "limit_reached",
            "{}",
            view.text
        );
        assert_eq!(view.data()["planUsage"]["resetsAt"].is_string(), reset);
        let text =
            std::fs::read_to_string(s.sandbox.data.join("app/developer-logs/model-turns.jsonl"))?;
        let log: Value = serde_json::from_str(text.lines().last().unwrap())?;
        assert_eq!(
            log["response"]["raw"]["failure"]["providerErrorCode"],
            "subscription_sharing_usage_limit_exceeded",
            "{log}"
        );
        assert_eq!(
            log["response"]["raw"]["failure"]["providerRequestId"], "plan-limit-request",
            "{log}"
        );
        assert!(log.to_string().contains("quota"));
        let path = s.sandbox.data.join("metrics/provider-quota.json");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let before = std::fs::metadata(&path)?.modified()?;
        s.turn("general", "repeated plan limit").await?;
        assert_eq!(std::fs::metadata(&path)?.modified()?, before);
        state.lock().unwrap().terminal = Terminal::Completed;
        let (_, turn) = s.turn("general", "successful quota check").await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let view = s.gw.get("/provider-quota?provider_id=openai").await?;
        assert_eq!(view.data()["planUsage"]["state"], "in_use");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let bytes = tokio::fs::read(&path).await.unwrap();
                let persisted: Value = serde_json::from_slice(&bytes).unwrap();
                if persisted["plan_limit"]["openai"].is_null() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let cleared = std::fs::metadata(&path)?.modified()?;
        assert_ne!(cleared, before);
        s.gw.get("/provider-quota?provider_id=openai").await?;
        assert_eq!(std::fs::metadata(&path)?.modified()?, cleared);

        assert!(
            state
                .lock()
                .unwrap()
                .paths
                .iter()
                .all(|path| !path.contains("wham/usage") && !path.contains("backend-api"))
        );
        s.finish().await?;
        task.abort();
    }
    Ok(())
}

#[tokio::test]
async fn siwc_18_header_estimate_present_and_absent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for headers in [true, false] {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}/v1", listener.local_addr()?);
        let state = Arc::new(Mutex::new(Script {
            terminal: Terminal::Completed,
            headers,
            ..Default::default()
        }));
        let router = Router::new()
            .route("/v1/responses", post(reply))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                record_paths,
            ));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let s = Setup::new("SIWC-18")?
            .env("BUTLER_CHATGPT_API_BASE_URL", base)
            .start()
            .await?;
        assert_eq!(
            turn_state(&s.turn("general", "header estimate check").await?.1),
            "delivered"
        );
        let view = s.gw.get("/provider-quota?provider_id=openai").await?;
        let view = view.data();
        assert_eq!(view["sourceKind"], "chatgpt_plan");
        assert_eq!(view["planUsage"]["state"], "in_use");
        assert!(view["reason"].is_null());
        assert_eq!(
            view["windows"].as_array().unwrap().len(),
            usize::from(headers)
        );
        if headers {
            assert_eq!(view["estimated"], true);
            assert_eq!(view["credits"]["balance"], "12.5");
        } else {
            assert!(view["credits"].is_null());
        }
        let usage = s.gw.get("/usage-monitor").await?;
        assert_eq!(
            super::windows::usage(usage.data())["account"],
            "chatgpt_plan"
        );
        assert!(
            state
                .lock()
                .unwrap()
                .paths
                .iter()
                .all(|path| !path.contains("wham/usage") && !path.contains("backend-api"))
        );
        s.finish().await?;
        task.abort();
    }
    Ok(())
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

async fn record_paths(
    State(state): State<Arc<Mutex<Script>>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    state
        .lock()
        .unwrap()
        .paths
        .push(request.uri().path().to_owned());
    next.run(request).await
}
