//! Offline request reconstruction through the real provider serializer and a
//! loopback stub. JSONL on stdin contains model/scope/label/instructions/tools/
//! messages. Only token estimates and content-free diagnostics go to stdout.
mod support;
use butler_models::models::*;
use butler_turn::btcc::{
    ModelRoundError, ModelRoundMessage, ModelRoundPort, ModelRoundRequest, ModelRoundTool,
    UsageAttribution,
};
use serde::Deserialize;
use std::{io::BufRead, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
struct RecordedRequest {
    model: String,
    scope: String,
    label: String,
    instructions: String,
    tools: Vec<ModelRoundTool>,
    messages: Vec<ModelRoundMessage>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(path) = std::env::args().nth(1) {
        let prefixes: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(path)?)?;
        let tokenizer = tiktoken_rs::o200k_base()?;
        let counts: std::collections::BTreeMap<_, _> = prefixes
            .into_iter()
            .map(|(key, value)| (key, tokenizer.encode_ordinary(&value).len()))
            .collect();
        println!("{}", serde_json::to_string(&counts)?);
        return Ok(());
    }
    let catalog = Arc::new(ModelCatalog::new()?);
    let snapshot = Arc::new(catalog.snapshot(
        ModelCatalogSnapshotInput {
            configured_local: vec![],
            extra_models: vec![],
            registered_models: vec![],
            credential_views: vec![],
            default_model_ref: None,
            generated_at: "offline".into(),
        },
        &butler_core::locale::LocaleCollation::new("en-US")?,
    )?);
    let (endpoint, server) = support::server().await?;
    let provider = ModelProvider::new(
        reqwest::Client::new(),
        Arc::new(support::Config { endpoint, snapshot }),
        Arc::new(support::Observer),
        catalog,
        Arc::new(support::Clock),
        Arc::new(support::Metrics),
    );
    for line in std::io::stdin().lock().lines() {
        let request: RecordedRequest = serde_json::from_str(&line?)?;
        run(&provider, &request).await?;
    }
    server.abort();
    Ok(())
}

async fn run(provider: &ModelProvider, recorded: &RecordedRequest) -> Result<(), ModelRoundError> {
    let attribution = UsageAttribution {
        prompt_diagnostics: None,
        session_kind: Some("parent".into()),
        turn_id: recorded.label.clone(),
        phase: "reconstructed-replay".into(),
        reasoning_effort: None,
        round_index: None,
    };
    provider
        .run_round(ModelRoundRequest {
            max_output_tokens: None,
            round_id: None,
            model: &recorded.model,
            messages: &recorded.messages,
            instructions: Some(&recorded.instructions),
            tools: &recorded.tools,
            tool_surface_digest: None,
            tool_choice: None,
            reasoning_effort: &butler_turn::btcc::ReasoningEffort::Medium,
            cancellation: CancellationToken::new(),
            attachments: &[],
            image_carrier: None,
            image_capability: None,
            image_manifests: &[],
            verified_image_payload: None,
            butler_data: None,
            usage_attribution: Some(&attribution),
            cache_scope: Some(&recorded.scope),
            stable_provider_cache_prefix: None,
            route_context: None,
            provider_retry_attempts: Some(1.0),
            route_transport_attempt_ordinal: None,
            continuation: None,
            bounded_continuation: None,
            provider_body_admission: None,
            stream_observer: None,
            identity_observer: None,
        })
        .await?;
    Ok(())
}
