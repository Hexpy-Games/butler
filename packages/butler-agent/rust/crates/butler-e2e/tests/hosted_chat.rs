//! Offline hosted chat contracts through the production adapter and HTTP stream.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
#[path = "../src/bin/provider_stream/config.rs"]
mod config;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_core::locale::LocaleCollation;
use butler_models::models::*;
use butler_turn::btcc::{
    ModelRoundMessage, ModelRoundPort, ModelRoundTool, ProviderStreamObserver, ToolChoice,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

type Error = Box<dyn std::error::Error>;
#[derive(Default)]
struct Events(Mutex<Vec<Value>>);
impl ProviderStreamObserver for Events {
    fn event(&self, event: &Value) {
        self.0.lock().unwrap().push(event.clone());
    }
}
#[derive(Clone)]
struct Wire {
    bodies: Arc<Mutex<Vec<Value>>>,
    field: &'static str,
    cumulative: bool,
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn chat(State(wire): State<Wire>, Json(body): Json<Value>) -> impl IntoResponse {
    wire.bodies.lock().unwrap().push(body.clone());
    let followup = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "tool");
    let reasoning = json!({"role":"assistant",wire.field:"Check the tool."});
    let mut deltas = vec![reasoning];
    if followup {
        deltas.extend([
            json!({"role":"assistant","content":"Delivered"}),
            json!({"role":"assistant","content":"."}),
        ]);
    } else {
        deltas.extend([
            json!({"content":"\n"}),
            json!({"content":null,"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"inspect"}}]}),
            json!({"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}),
            json!({"tool_calls":[{"index":0,"function":{"arguments":"\"Seoul\"}"}}]}),
        ]);
    }
    let reported = if body["model"] == "solar-pro4" {
        "solar-pro4-260806"
    } else if body["model"] == "solar-mini4" {
        "solar-mini4-260922"
    } else {
        body["model"].as_str().unwrap()
    };
    let mut text = String::from(": keep-alive\n\n");
    for (i, delta) in deltas.iter().enumerate() {
        let mut chunk =
            json!({"model":reported,"choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        if wire.cumulative {
            chunk["usage"] =
                json!({"prompt_tokens":240,"completion_tokens":i+1,"total_tokens":241+i});
        }
        text.push_str(&format!("data: {chunk}\n\n"));
    }
    let mut usage = if wire.field == "reasoning_content" {
        json!({"prompt_tokens":240,"completion_tokens":80,"total_tokens":320,"prompt_cache_hit_tokens":40,"completion_tokens_details":{"reasoning_tokens":66}})
    } else {
        json!({"prompt_tokens":240,"completion_tokens":80,"total_tokens":320,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":66}})
    };
    if wire.cumulative {
        usage["prompt_tokens_details"]["created_cache_tokens"] = 128.into();
        usage
            .as_object_mut()
            .unwrap()
            .remove("completion_tokens_details");
    }
    let mut finish = json!({"model":reported,"choices":[{"index":0,"delta":{},"finish_reason":if followup {"stop"} else {"tool_calls"}}]});
    // DeepSeek carries usage on the last content chunk; others use choices:[].
    if wire.field == "reasoning_content" {
        finish["usage"] = usage.clone();
    }
    text.push_str(&format!("data: {finish}\n\n"));
    if wire.field != "reasoning_content" {
        text.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[],"usage":usage})
        ));
    }
    text.push_str("data: [DONE]\n\n");
    ([("content-type", "text/event-stream")], text)
}

fn snapshot(catalog: &ModelCatalog) -> Result<Arc<ModelCatalogSnapshot>, Error> {
    Ok(Arc::new(catalog.snapshot(
        ModelCatalogSnapshotInput {
            configured_local: vec![],
            extra_models: vec![],
            registered_models: vec![],
            credential_views: vec![],
            default_model_ref: None,
            generated_at: "now".into(),
        },
        &LocaleCollation::new("en-US")?,
    )?))
}

async fn provider(
    model: &str,
    wire: &Wire,
) -> Result<(ModelProvider, ModelProviderMetadata, Server), Error> {
    let app = Router::new()
        .route("/v1/chat/completions", post(chat))
        .with_state(wire.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = url::Url::parse(&format!(
        "http://{}/v1/chat/completions",
        listener.local_addr()?
    ))?;
    let server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let catalog = Arc::new(ModelCatalog::new()?);
    let snapshot = snapshot(&catalog)?;
    let metadata = snapshot.find_model_metadata(Some(model)).unwrap();
    let provider = ModelProvider::new(
        provider_http_client()?,
        Arc::new(config::Config {
            metadata: metadata.clone(),
            endpoint,
            snapshot,
            codex: false,
        }),
        Arc::new(config::Observations),
        catalog,
        Arc::new(config::Clock),
        Arc::new(config::Metrics),
    );
    Ok((provider, metadata, server))
}

async fn exercise(
    model: &str,
    field: &'static str,
    cumulative: bool,
    rates: [f64; 3],
) -> Result<(), Error> {
    let wire = Wire {
        bodies: Arc::default(),
        field,
        cumulative,
    };
    let (provider, metadata, _server) = provider(model, &wire).await?;
    let events = Events::default();
    let mut messages = vec![ModelRoundMessage::user("Inspect Seoul.".into(), None)];
    let tools = [ModelRoundTool {
        name: "inspect".into(),
        description: "Inspect a city".into(),
        parameters: json!({"type":"object","properties":{"city":{"type":"string"}}})
            .as_object()
            .unwrap()
            .clone(),
        concurrency_safe: None,
        transcript_visibility: None,
        handler_validates_arguments: None,
        tool_contract_version: None,
    }];
    let effort = butler_turn::btcc::ReasoningEffort::High;
    for round in 0..3 {
        let mut request =
            config::request(model, &messages, &effort, CancellationToken::new(), None);
        request.tools = &tools;
        request.tool_choice = Some(ToolChoice::Required);
        request.stream_observer = Some(&events);
        let result = provider.run_round(request).await?;
        assert_eq!(result.reasoning_summary.as_deref(), Some("Check the tool."));
        let usage = result.usage.as_ref().unwrap();
        assert_eq!(usage["model"], model);
        assert_eq!(usage["promptTokens"], 240.0);
        assert_eq!(usage["cachedTokens"], 40.0);
        assert_eq!(usage["outputTokens"], 80.0);
        assert_eq!(usage["totalTokens"], 320.0);
        if cumulative {
            assert!(usage.get("reasoningTokens").is_none());
        } else {
            assert_eq!(usage["reasoningTokens"], 66.0);
        }
        if cumulative {
            assert_eq!(usage["cacheWriteTokens"], 128.0);
        }
        let prices = metadata
            .pricing
            .as_ref()
            .unwrap()
            .prices_at(240, "2026-10-29")
            .unwrap();
        assert_eq!(
            [
                prices.input_per_mtok_usd,
                prices.cached_input_per_mtok_usd.unwrap(),
                prices.output_per_mtok_usd
            ],
            rates
        );
        let cost = prices
            .estimate_usd(&RequestTokens {
                input: 240,
                cached: 40,
                output: 80,
                cache_write: if cumulative { 128 } else { 0 },
                ..Default::default()
            })
            .unwrap();
        assert!(
            (cost - (200.0 * rates[0] + 40.0 * rates[1] + 80.0 * rates[2]) / 1e6).abs() < 1e-12
        );
        if round == 0 {
            assert_eq!(result.tool_calls.len(), 1);
            assert_eq!(
                &result.tool_calls[0].arguments,
                json!({"city":"Seoul"}).as_object().unwrap()
            );
        } else {
            assert_eq!(result.text.as_deref(), Some("Delivered."));
        }
        messages.push(result.assistant_message.unwrap());
        if round == 0 {
            let mut tool = ModelRoundMessage::user("Seoul inspected.".into(), None);
            tool.role = butler_turn::btcc::ModelRoundRole::Tool;
            tool.tool_call_id = Some("call-1".into());
            messages.push(tool);
        } else {
            messages.push(ModelRoundMessage::user("Continue.".into(), None));
        }
    }
    let bodies = wire.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 3);
    assert_history(&bodies, field);
    let events = events.0.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "reasoning_delta")
            .count(),
        3
    );
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "text_delta" && e["textDelta"] == "Delivered")
    );
    Ok(())
}

fn assert_history(bodies: &[Value], field: &str) {
    let allowed = [
        "model",
        "messages",
        "stream",
        "stream_options",
        "tools",
        "tool_choice",
        "temperature",
        "max_tokens",
        "reasoning_effort",
        "parallel_tool_calls",
        "response_format",
    ];
    for body in bodies {
        assert!(
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["role"] != "developer")
        );
        if field == "reasoning_content" {
            assert_eq!(body["thinking"]["type"], "enabled");
            assert_eq!(body["tool_choice"], "auto");
        } else {
            assert!(
                body.as_object()
                    .unwrap()
                    .keys()
                    .all(|k| allowed.contains(&k.as_str()))
            );
            assert!(body.get("thinking").is_none());
            if body["model"] == "motif/motif-3" {
                assert!(body.get("reasoning_effort").is_none());
            }
        }
        for message in body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "assistant")
        {
            if field == "reasoning_content" {
                assert_eq!(message["reasoning_content"], "Check the tool.");
            } else {
                assert!(message.get("reasoning").is_none());
                assert!(message.get("reasoning_content").is_none());
            }
        }
    }
}

#[tokio::test]
async fn deepseek_stream_history_and_cost() -> Result<(), Error> {
    butler_e2e::gate!();
    exercise(
        "deepseek/deepseek-flash",
        "reasoning_content",
        false,
        [0.30, 0.006, 1.20],
    )
    .await?;
    exercise(
        "deepseek/deepseek-v4-pro",
        "reasoning_content",
        false,
        [1.32, 0.044, 3.96],
    )
    .await
}
#[tokio::test]
async fn upstage_strict_wire_dated_model_and_cost() -> Result<(), Error> {
    butler_e2e::gate!();
    exercise("upstage/solar-pro4", "reasoning", false, [0.30, 0.06, 1.20]).await?;
    exercise(
        "upstage/solar-mini4",
        "reasoning",
        false,
        [0.10, 0.01, 0.40],
    )
    .await
}
#[tokio::test]
async fn motif_running_usage_history_and_cost() -> Result<(), Error> {
    butler_e2e::gate!();
    exercise("motif/motif/motif-3", "reasoning", true, [0.20, 0.04, 0.80]).await
}
