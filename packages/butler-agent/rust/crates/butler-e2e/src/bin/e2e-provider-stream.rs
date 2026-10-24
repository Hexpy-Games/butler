//! Offline process proof: replay bytes through the production provider and relay.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "E2E fixture assertions"
)]
#[path = "provider_stream/config.rs"]
mod config;
use butler_core::{locale::LocaleCollation, tool_protocol::ToolCallStreamEvent};
use butler_models::models::*;
use butler_turn::btcc::{
    AgentLoopProgress, AnswerBlocksStreamPort, ModelRoundMessage, ModelRoundPort, PortFuture,
    ProviderStreamObserver, RuntimeTurnEventInput, StreamRelay,
};
use serde_json::{Value, json};
use std::{
    io::Read,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Captured(Mutex<Vec<ToolCallStreamEvent>>);
impl AnswerBlocksStreamPort for Captured {
    fn tool_call<'a>(
        &'a self,
        event: ToolCallStreamEvent,
        _: &'a dyn AgentLoopProgress,
    ) -> PortFuture<'a, ()> {
        self.0.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
    fn clear(&self) {}
}
#[derive(Default)]
struct DefaultObserver(Mutex<Vec<Value>>);
impl ProviderStreamObserver for DefaultObserver {
    fn event(&self, event: &Value) {
        self.0.lock().unwrap().push(event.clone());
    }
}
struct Tap {
    relay: Arc<dyn ProviderStreamObserver>,
    events: Mutex<Vec<Value>>,
    default_observer: DefaultObserver,
}
impl ProviderStreamObserver for Tap {
    fn tool_call(&self, event: &ToolCallStreamEvent) {
        self.default_observer.tool_call(event);
        self.relay.tool_call(event);
    }
    fn event(&self, event: &Value) {
        self.events.lock().unwrap().push(event.clone());
        self.relay.event(event);
    }
}
#[derive(Default)]
struct Progress(Mutex<Vec<RuntimeTurnEventInput>>);
impl AgentLoopProgress for Progress {
    fn emit(&self, event: RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        self.0.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cases: Vec<Value> = serde_json::from_str(&input)?;
    let mut results = Vec::new();
    for case in cases {
        results.push(run(case).await?);
    }
    println!("{}", json!(results));
    Ok(())
}

async fn run(case: Value) -> Result<Value, Box<dyn std::error::Error>> {
    use axum::{Router, response::IntoResponse, routing::post};
    let body = case["body"].as_str().unwrap().to_owned();
    let content_type = if case["sse"] == true {
        "text/event-stream"
    } else {
        "application/json"
    };
    let mut app = Router::new().fallback(post(move || async move {
        ([("content-type", content_type)], body).into_response()
    }));
    if case["codex"] == true {
        app = app.layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = url::Url::parse(&format!("http://{}/v1/responses", listener.local_addr()?))?;
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let wire = butler_e2e::e2e::chatgpt_wire::Scope::new(&[(
        "BUTLER_CHATGPT_API_BASE_URL".into(),
        endpoint.to_string(),
    )]);
    let result = invoke(&case, endpoint).await;
    server.abort();
    let _ = server.await;
    wire.finish()?;
    result
}

async fn invoke(case: &Value, endpoint: url::Url) -> Result<Value, Box<dyn std::error::Error>> {
    let catalog = Arc::new(ModelCatalog::new()?);
    let snapshot = Arc::new(catalog.snapshot(
        ModelCatalogSnapshotInput {
            configured_local: vec![],
            extra_models: vec![],
            registered_models: vec![],
            credential_views: vec![],
            default_model_ref: None,
            generated_at: "now".into(),
        },
        &LocaleCollation::new("en-US")?,
    )?);
    let model = match case["provider"].as_str().unwrap() {
        "qwen" => "qwen/qwen3.7-max",
        "anthropic" => "anthropic/claude-sonnet-5",
        "google" => "google/gemini-3.8-flash",
        _ => "openai/gpt-5.5",
    };
    let mut metadata = snapshot.find_model_metadata(Some(model)).unwrap();
    metadata.hosted_api_shape = if case["chat"] == true {
        Some(HostedApiShape::OpenaiChatCompletions)
    } else {
        None
    };
    let provider = ModelProvider::new(
        provider_http_client()?,
        Arc::new(config::Config {
            metadata,
            endpoint,
            snapshot,
            codex: case["codex"] == true,
        }),
        Arc::new(config::Observations),
        catalog,
        Arc::new(config::Clock),
        Arc::new(config::Metrics),
    );
    let captured = Arc::new(Captured::default());
    let relay = StreamRelay::new().with_answer_blocks(captured.clone());
    let tap = Tap {
        relay: relay.observer(),
        events: Mutex::default(),
        default_observer: DefaultObserver::default(),
    };
    let messages = [ModelRoundMessage::user(
        "Build structured records.".into(),
        None,
    )];
    let mut request = config::request(
        model,
        &messages,
        &butler_turn::btcc::ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    request.stream_observer = Some(&tap);
    let result = provider.run_round(request).await?;
    let done = CancellationToken::new();
    done.cancel();
    let progress = Progress::default();
    relay.publish(&progress, done).await;
    let events = tap.events.lock().unwrap();
    let relayed = captured.0.lock().unwrap();
    Ok(
        json!({"defaultToolFrames":tap.default_observer.0.lock().unwrap().len(),"events":*events,"relayed":*relayed,"calls":result.tool_calls,"durableFrames":progress.0.lock().unwrap().len()}),
    )
}
