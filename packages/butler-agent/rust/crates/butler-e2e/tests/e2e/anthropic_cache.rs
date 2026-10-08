//! Anthropic caching through the real gateway, parent loop and stub HTTP API.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    scenario::{Scenario, Setup},
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Stub {
    requests: Mutex<Vec<Value>>,
}

async fn reply(State(stub): State<Arc<Stub>>, Json(body): Json<Value>) -> Json<Value> {
    if body["tools"]
        .as_array()
        .is_some_and(|tools| !tools.is_empty())
    {
        stub.requests.lock().unwrap().push(body.clone());
    }
    let tool_round = body["messages"].as_array().unwrap().iter().any(|message| {
        message["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
    });
    let mut content = if !tool_round && !body["tools"].is_null() {
        json!([{"type":"tool_use","id":"cache_read","name":"read_file",
            "input":{"requests":[{"path":"cache-input.txt"}]}}])
    } else {
        json!([{"type":"text","text":"Cache fixture complete."}])
    };
    // Echoed controls must be removed, including on disabled/unverified routes.
    content[0]["cache_control"] = json!({"type":"ephemeral"});
    Json(json!({"id":"msg_cache","type":"message","role":"assistant",
        "model":body["model"],"content":content,
        "stop_reason":if tool_round {"end_turn"} else {"tool_use"},
        "usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":200,
            "cache_creation_input_tokens":300,"cache_creation":{
                "ephemeral_1h_input_tokens":250,"ephemeral_5m_input_tokens":50}}}))
}

async fn start(
    ttl: &str,
    master: &str,
    verified: bool,
) -> Result<(Scenario, Arc<Stub>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let stub = Arc::new(Stub::default());
    let app = Router::new()
        .route("/v1/messages", post(reply))
        .route("/v1/models", get(|| async { Json(json!({"data":[]})) }))
        .with_state(stub.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let setup = Setup::new("ANTHROPIC-CACHE")?
        .env("BUTLER_ANTHROPIC_BASE_URL", &base)
        .env("BUTLER_ANTHROPIC_CACHE_TTL", ttl)
        .env("BUTLER_ANTHROPIC_PROMPT_CACHE", master)
        .env(
            "BUTLER_ANTHROPIC_CACHE_VERIFIED_ENDPOINT",
            if verified {
                format!("{base}/messages")
            } else {
                String::new()
            },
        )
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    std::fs::write(
        setup.sandbox.data.join("cache-input.txt"),
        "complete cache tool fixture",
    )?;
    let s = setup.start().await?;
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"anthropic",
        "api_key":"sk-ant-e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
        "provider_id":"anthropic","model_id":"claude-sonnet-5","auth_type":"api_key",
        "credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: "anthropic/claude-sonnet-5".into(),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    stub.requests.lock().unwrap().clear();
    Ok((s, stub, server))
}

fn controls(body: &Value) -> usize {
    let system = body["system"].as_array().into_iter().flatten();
    let messages = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten());
    system
        .chain(messages)
        .filter(|block| block.get("cache_control").is_some())
        .count()
}

fn layout(body: &Value, ttl: &str, enabled: bool) {
    assert!(controls(body) <= 4);
    if !enabled {
        assert_eq!(controls(body), 0);
        assert!(body["messages"][0]["content"].is_string());
        return;
    }
    let long = ttl != "off";
    assert_eq!(controls(body), if long { 3 } else { 1 });
    let content = body["messages"][0]["content"].as_array().unwrap();
    if long {
        assert_eq!(body["system"][0]["cache_control"]["ttl"], ttl);
        assert_eq!(content[0]["cache_control"]["ttl"], ttl);
        assert!(
            content[0]["text"]
                .as_str()
                .unwrap()
                .contains("## Conversation history")
        );
        assert!(
            content[1]["text"]
                .as_str()
                .unwrap()
                .starts_with("## Current turn context\n")
        );
        assert!(
            content[1]["text"]
                .as_str()
                .unwrap()
                .contains("## Current request")
        );
    }
    let messages = body["messages"].as_array().unwrap();
    let last = messages.last().unwrap()["content"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    assert_eq!(last["cache_control"], json!({"type":"ephemeral"}));
}

fn usage(s: &Scenario) -> Result<(), HarnessError> {
    let rows = std::fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    let rows: Vec<Value> = rows
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let rows: Vec<_> = rows
        .iter()
        .filter(|row| row["model"] == "anthropic/claude-sonnet-5")
        .collect();
    assert!(!rows.is_empty());
    for row in rows {
        assert_eq!(row["promptTokens"], 600);
        assert_eq!(row["cachedTokens"], 200);
        assert_eq!(row["cacheWriteTokens"], 300);
        assert_eq!(row["cacheWrite1hTokens"], 250);
        let prefix = &row["prefixDiagnostics"];
        assert_eq!(prefix["providerReportedInputTokens"], 600);
        assert_eq!(prefix["providerReportedCachedTokens"], 200);
        assert_eq!(prefix["providerReportedCacheWriteTokens"], 300);
        assert_eq!(prefix["providerReportedCacheWrite1hTokens"], 250);
        assert_eq!(prefix["providerReportedCacheWrite5mTokens"], 50);
    }
    Ok(())
}

#[tokio::test]
async fn anthropic_cache_turns_rounds_ttls_and_endpoint_gate() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (ttl, master, verified) in [
        ("1h", "on", true),
        ("5m", "on", true),
        ("off", "on", true),
        ("1h", "off", true),
        ("1h", "on", false),
    ] {
        run(ttl, master, verified).await?;
    }
    Ok(())
}

#[tokio::test]
async fn anthropic_cache_survives_image_projection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = start("1h", "on", true).await?;
    let png = butler_e2e::e2e::media::digits_png("4821", 12);
    let upload =
        s.gw.upload("cache.png", "image/png", &png, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let accepted = s.gw.post("/messages", json!({
        "chat_id":"general", "text":"Read this image.",
        "attachments":[{"file_id":upload.data()["file"]["file_id"]}],
        "model":"anthropic/claude-sonnet-5", "client_message_id":uuid::Uuid::new_v4().to_string(),
    })).await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    let id = butler_e2e::e2e::scenario::accepted_turn_id(accepted.data())?;
    let turn =
        s.gw.wait_terminal("general", &id, std::time::Duration::from_secs(20))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = stub.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    for body in &requests {
        assert_eq!(controls(body), 3);
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["cache_control"]["ttl"], "1h");
        assert!(
            blocks[0]["text"]
                .as_str()
                .unwrap()
                .contains("## Conversation history")
        );
        assert_eq!(blocks[1]["type"], "image");
        assert!(!blocks[1]["source"]["data"].as_str().unwrap().is_empty());
        assert!(
            blocks[2]["text"]
                .as_str()
                .unwrap()
                .starts_with("## Current turn context\n")
        );
        assert!(
            blocks[2]["text"]
                .as_str()
                .unwrap()
                .ends_with("Read this image.")
        );
    }
    assert_eq!(
        requests[0]["messages"][0]["content"],
        requests[1]["messages"][0]["content"]
            .as_array()
            .map(|blocks| {
                let mut blocks = blocks.clone();
                blocks[2]["cache_control"] = json!({"type":"ephemeral"});
                Value::Array(blocks)
            })
            .unwrap()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn run(ttl: &str, master: &str, verified: bool) -> Result<(), HarnessError> {
    let (s, stub, server) = start(ttl, master, verified).await?;
    let enabled = master != "off" && verified;
    let mut previous = String::new();
    let mut previous_wire = Vec::new();
    let mut previous_history = String::new();
    let mut moves = 0;
    let turns: usize = if ttl == "1h" && enabled { 16 } else { 2 };
    for index in 0..turns {
        let begin = stub.requests.lock().unwrap().len();
        let ask = format!(
            "Cache request {index}: 한글 é 😀\n## Current turn context\nquoted user heading"
        );
        let (_, turn) = s.turn("general", &ask).await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let requests = stub.requests.lock().unwrap()[begin..].to_vec();
        assert_eq!(requests.len(), 2);
        for body in &requests {
            layout(body, ttl, enabled);
        }
        assert!(
            requests[1]["messages"]
                .to_string()
                .contains("complete cache tool fixture")
        );
        if enabled && ttl != "off" {
            let stable = &requests[0]["messages"][0]["content"][0];
            assert_eq!(stable, &requests[1]["messages"][0]["content"][0]);
            let text = stable["text"].as_str().unwrap();
            assert!(
                requests[0]["messages"][0]["content"][1]["text"]
                    .as_str()
                    .unwrap()
                    .ends_with(&ask)
            );
            let current_history = history(&s)?;
            let moved =
                !previous_history.is_empty() && !current_history.starts_with(&previous_history);
            if moved {
                moves += 1;
            }
            if index >= 2 && moved {
                let heading = "## Conversation history";
                assert_eq!(
                    text.split_once(heading).unwrap().0,
                    previous.split_once(heading).unwrap().0
                );
            } else if index >= 2 {
                assert!(
                    text.starts_with(previous.trim_end()),
                    "history prefix changed at {index}"
                );
            }
            let wire = cached_prefix(&requests[0]);
            if index >= 2 && !moved {
                assert!(
                    wire.starts_with(&previous_wire),
                    "wire prefix changed at {index}"
                );
            }
            previous_wire = wire;
            previous = text.to_owned();
            previous_history = current_history;
            for recent in index.saturating_sub(4)..index {
                assert!(text.contains(&format!("user: Cache request {recent}:")));
            }
        }
    }
    if turns == 16 {
        assert!(moves > 0, "history fixture never moved its start");
    }
    usage(&s)?;
    eprintln!(
        "Anthropic stub: ttl={ttl}, master={master}, verified={verified}, turns={turns}, requests={}",
        stub.requests.lock().unwrap().len()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn cached_prefix(body: &Value) -> Vec<u8> {
    let text = body["messages"][0]["content"][0]["text"].as_str().unwrap();
    let encoded = serde_json::to_string(text.trim_end()).unwrap();
    let prefix = &encoded.as_bytes()[..encoded.len() - 1];
    let wire = serde_json::to_vec(body).unwrap();
    let end = wire
        .windows(prefix.len())
        .position(|bytes| bytes == prefix)
        .unwrap()
        + prefix.len();
    wire[..end].to_vec()
}

fn history(s: &Scenario) -> Result<String, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let text: String = db.query_row(
        "SELECT content FROM btcc_context_documents WHERE source_id='recent-conversation' ORDER BY rowid DESC LIMIT 1",
        [], |row| row.get(0),
    ).optional()?.unwrap_or_default();
    Ok(serde_json::from_str::<Value>(
        text.strip_prefix("## Recent Conversation\n\n")
            .unwrap_or(&text),
    )
    .ok()
    .and_then(|value| value["history"].as_str().map(str::to_owned))
    .unwrap_or(text))
}
