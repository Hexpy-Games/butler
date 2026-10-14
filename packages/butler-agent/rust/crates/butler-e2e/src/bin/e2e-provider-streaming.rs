//! Replay companion: invoke the public provider adapter across a process boundary.
#[path = "provider_streaming/config.rs"]
mod config;
#[path = "provider_streaming/request.rs"]
mod request;

use butler_models::models::*;
use butler_turn::btcc::{ModelRoundMessage, ProviderStreamObserver};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

type Error = Box<dyn std::error::Error>;

#[derive(Default)]
struct Events(Mutex<Vec<Value>>);
impl ProviderStreamObserver for Events {
    fn event(&self, value: &Value) {
        if let Ok(mut events) = self.0.lock() {
            events.push(value.clone());
        }
    }
    fn tool_call(&self, event: &butler_core::tool_protocol::ToolCallStreamEvent) {
        if let Ok(value) = serde_json::to_value(event) {
            self.event(&value);
        }
    }
    fn round_text_discarded(&self) {
        self.event(&json!({"type":"discarded"}));
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [endpoint, model, shape, rounds, attempts] = args.as_slice() else {
        return Err("expected endpoint model shape rounds attempts".into());
    };
    let endpoint = url::Url::parse(endpoint)?;
    if endpoint.host_str() != Some("127.0.0.1") {
        return Err("replay requires loopback".into());
    }
    let provider = provider(endpoint, shape)?;
    let messages = [ModelRoundMessage::user(
        "Replay the provider contract.".into(),
        None,
    )];
    let events = Events::default();
    let mut results = Vec::new();
    for _ in 0..rounds.parse()? {
        let result =
            request::request(&provider, model, &messages, &events, attempts.parse()?).await;
        match result {
            Ok(result) => results.push(serde_json::to_value(result)?),
            Err(butler_turn::btcc::ModelRoundError::Provider(error)) => {
                results.push(json!({"error":error.code,"retryable":error.retryable}));
            }
            Err(error) => return Err(error.into()),
        }
    }
    let output =
        json!({"results":results,"events":*events.0.lock().map_err(|_| "events poisoned")?});
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

fn provider(endpoint: url::Url, shape: &str) -> Result<ModelProvider, Error> {
    let catalog = Arc::new(ModelCatalog::new()?);
    let snapshot = Arc::new(catalog.snapshot(
        ModelCatalogSnapshotInput {
            configured_local: vec![],
            extra_models: vec![],
            registered_models: vec![],
            credential_views: vec![],
            default_model_ref: None,
            generated_at: "replay".into(),
        },
        &butler_core::locale::LocaleCollation::new("en-US")?,
    )?);
    Ok(ModelProvider::new(
        reqwest::Client::new(),
        Arc::new(config::Config {
            endpoint,
            snapshot,
            shape: (shape == "responses").then_some(HostedApiShape::OpenaiResponses),
        }),
        Arc::new(config::Observer),
        catalog,
        Arc::new(config::Clock),
        Arc::new(config::Metrics),
    ))
}
