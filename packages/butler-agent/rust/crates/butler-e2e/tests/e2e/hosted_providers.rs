//! Settings key setup and selection of the new hosted chat providers.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    response::IntoResponse,
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn chat(Json(body): Json<Value>) -> impl IntoResponse {
    let chunk = json!({"model":body["model"],"choices":[{"delta":{"role":"assistant","content":"Delivered."},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
    (
        [("content-type", "text/event-stream")],
        format!("data: {chunk}\n\ndata: [DONE]\n\n"),
    )
}
async fn start() -> Result<(Scenario, Server), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let app = Router::new().route("/v1/chat/completions",post(chat))
        .route("/v1/models",get(||async { Json(json!({"data":[{"id":"deepseek-flash"},{"id":"deepseek-v4-pro"},{"id":"solar-pro4"},{"id":"solar-mini4"},{"id":"motif/motif-3"}]})) }));
    let server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let s = Setup::new("HOSTED-PROVIDERS")?
        .env("BUTLER_DEEPSEEK_BASE_URL", &base)
        .env("BUTLER_UPSTAGE_BASE_URL", &base)
        .env("BUTLER_MOTIF_BASE_URL", &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    Ok((s, server))
}
async fn register(
    s: &Scenario,
    provider: &str,
    model: &str,
    effort: &str,
    created: bool,
) -> Result<(), HarnessError> {
    let verified =
        s.gw.post(
            "/setup/credentials/verify",
            json!({"provider_id":provider,"api_key":"e2e-placeholder"}),
        )
        .await?;
    assert_eq!(verified.status, 200, "{}", verified.text);
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":provider,"api_key":"e2e-placeholder"}),
        )
        .await?;
    assert_eq!(
        saved.status,
        if created { 201 } else { 200 },
        "{}",
        saved.text
    );
    assert_eq!(saved.data()["created"], created);
    let credential_id = saved.data()["credential"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let registered = s.gw.post("/model-catalog/registered-models",json!({"provider_id":provider,"model_id":model,"auth_type":"api_key","credential_id":credential_id})).await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: format!("{provider}/{model}"),
            effort: Some(effort.into()),
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    assert_eq!(
        s.gw.settings().await?["model"],
        format!("{provider}/{model}")
    );
    let (_, turn) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    Ok(())
}
/// The model add/edit page lists catalog providers in order and preselects
/// the first: existing providers keep their place, newer ones follow.
async fn assert_provider_picker_order(s: &Scenario) -> Result<(), HarnessError> {
    let catalog = s.gw.get("/model-catalog").await?;
    assert_eq!(catalog.status, 200, "{}", catalog.text);
    let ids = catalog.data()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|provider| provider["provider_id"].as_str())
        .filter(|id| *id != "local")
        .collect::<Vec<_>>();
    let expected = [
        "openai",
        "anthropic",
        "google",
        "xai",
        "qwen",
        "kimi",
        "zai",
        "zai-api",
        "opencode-go",
        "deepseek",
        "upstage",
        "motif",
    ];
    assert_eq!(ids, expected);
    Ok(())
}
#[tokio::test]
async fn settings_keys_select_and_route_each_hosted_provider() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _server) = start().await?;
    assert_provider_picker_order(&s).await?;
    let mut connected = std::collections::BTreeSet::new();
    for (provider, model, effort) in [
        ("deepseek", "deepseek-flash", "high"),
        ("deepseek", "deepseek-v4-pro", "none"),
        ("upstage", "solar-pro4", "medium"),
        ("upstage", "solar-mini4", "none"),
        ("motif", "motif/motif-3", "none"),
    ] {
        register(&s, provider, model, effort, connected.insert(provider)).await?;
    }
    s.finish().await
}
