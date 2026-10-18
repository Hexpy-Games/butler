//! TRACE-01/05: public trace contract, durable queue correlation and external isolation.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer},
    scenario::accepted_turn_id,
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn turn_trace_complete_and_traceparent_joins_trace() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = super::setup_local_models::with_local_server("TRACE-01", &server).await?;
    let model = super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    assert_eq!(
        s.gw.get("/logs/trace/0123456789abcdef0123456789abcdef")
            .await?
            .status,
        403
    );
    super::outbound_http::logging(&s, "detailed").await?;
    let trace_id = "0123456789abcdef0123456789abcdef";
    let message_id = uuid::Uuid::new_v4().to_string();
    let response =
        s.gw.http()
            .post(format!("{}/messages", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("traceparent", format!("00-{trace_id}-0123456789abcdef-01"))
            .json(&json!({"chat_id":"general", "text":"Hello", "client_message_id":message_id}))
            .send()
            .await?;
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await?;
    let turn_id = accepted_turn_id(&accepted["data"])?;
    let message_id = accepted["data"]["accepted"]["id"].as_str().unwrap();
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn["state"], "delivered");
    let response = s.gw.get(&format!("/logs/trace/{trace_id}")).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let trace = response.data();
    assert_eq!(trace["trace_id"], trace_id);
    assert_eq!(trace["chat_id"], "general");
    assert_eq!(trace["turn_id"], turn_id);
    assert!(trace["model"].as_str().is_some_and(|m| model.ends_with(m)));
    assert_eq!(trace["truncated"], false);
    let spans = trace["spans"].as_array().unwrap();
    for name in [
        "turn.admit",
        "turn.dispatch",
        "turn.queue",
        "turn.run",
        "context.build",
        "route.select",
        "model.request",
        "http.request",
    ] {
        assert!(
            spans.iter().any(|s| s["name"] == name),
            "missing {name}: {trace}"
        );
    }
    for (i, span) in spans.iter().enumerate() {
        assert!(span["start_offset_ms"].as_f64().unwrap() >= 0.0);
        if let Some(parent) = span["parent_span_id"].as_str()
            && spans.iter().any(|s| s["span_id"] == parent)
        {
            assert!(spans[..i].iter().any(|s| s["span_id"] == parent));
        }
    }
    assert!(spans.iter().find(|s| s["name"] == "turn.run").unwrap()["attrs"]["model"].is_string());
    let gateway = spans
        .iter()
        .find(|s| s["category"] == "http.server" && s["attrs"]["route"] == "/messages")
        .unwrap();
    let admission = spans.iter().find(|s| s["name"] == "turn.admit").unwrap();
    assert!(
        gateway["start_offset_ms"].as_f64().unwrap()
            <= admission["start_offset_ms"].as_f64().unwrap()
    );
    let http = spans
        .iter()
        .find(|s| s["name"] == "http.request" && s["attrs"]["status"] == 200)
        .unwrap();
    assert_eq!(http["tone"], "model");
    assert!(http["duration_ms"].as_f64().unwrap() >= 0.0);
    let parent = spans
        .iter()
        .find(|s| s["span_id"] == http["parent_span_id"])
        .unwrap();
    assert_eq!(parent["name"], "model.request");
    for query in [
        format!("turn_id={turn_id}"),
        format!("chat_id=general&message_id={message_id}"),
    ] {
        let resolved = s.gw.get(&format!("/logs/trace?{query}")).await?;
        assert_eq!(resolved.status, 200, "{}", resolved.text);
        assert_eq!(resolved.data()["trace_id"], trace_id);
    }
    assert!(
        server
            .seen()
            .iter()
            .all(|r| !r.headers.contains_key("traceparent"))
    );
    eprintln!(
        "TRACE-01 spans={} scanned_bytes={} duration_ms={}",
        spans.len(),
        trace["scanned_bytes"],
        trace["duration_ms"]
    );
    s.finish().await
}

#[tokio::test]
async fn retry_fallback_spans() -> Result<(), HarnessError> {
    use butler_e2e::e2e::{
        cassette::{Cassette, Chunk},
        scenario::Setup,
    };
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TURN-01")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let success = cassette.exchanges[0].clone();
    cassette.exchanges[0].response.status = 429;
    cassette.exchanges[0].response.headers =
        vec![("content-type".into(), "application/json".into())];
    cassette.exchanges[0].response.chunks = vec![Chunk {
        delay_ms: 0,
        text: json!({"error":{"code":"rate_limit_exceeded","message":"Rate limited"}}).to_string(),
    }];
    cassette.exchanges.insert(1, success);
    let s = Setup::new("TRACE-02")?
        .stub_cassette(cassette)
        .env("BUTLER_MODEL_API_RETRY_ATTEMPTS", "3")
        .start()
        .await?;
    super::outbound_http::logging(&s, "detailed").await?;
    let (turn_id, turn) = s.turn("general", &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    let reply = s.gw.get(&format!("/logs/trace?turn_id={turn_id}")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let spans = reply.data()["spans"].as_array().unwrap();
    let requests: Vec<_> = spans
        .iter()
        .filter(|s| s["name"] == "model.request")
        .collect();
    assert_eq!(requests.len(), 2, "{}", reply.text);
    assert_eq!(requests[0]["attrs"]["attempt"], 1);
    assert_eq!(requests[0]["attrs"]["attempts"], 3);
    assert_eq!(requests[0]["status"], "error");
    assert_eq!(requests[0]["has_details"], true);
    assert!(requests[0]["attrs"]["failure"]["error"].is_string());
    assert_eq!(requests[1]["attrs"]["attempt"], 2);
    assert_eq!(requests[1]["status"], "ok");
    assert!(spans.iter().any(|s| s["name"] == "http.request"
        && s["attrs"]["status"] == 429
        && s["parent_span_id"] == requests[0]["span_id"]));
    assert!(
        spans
            .iter()
            .any(|s| s["name"] == "retry.wait" && s["tone"] == "wait")
    );
    s.finish().await
}

#[tokio::test]
async fn schedule_run_logged() -> Result<(), HarnessError> {
    use butler_e2e::e2e::{cassette::Cassette, scenario::Setup};
    butler_e2e::gate!();
    let cassette = Cassette::load("TURN-01")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let s = Setup::new("TRACE-03")?
        .stub_cassette(cassette)
        .start()
        .await?;
    super::outbound_http::logging(&s, "detailed").await?;
    let created = s.gw.post("/automations", json!({"title":"Trace", "prompt_body":prompt,"target_session_id":"general","interval_seconds":3600})).await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["automation"]["id"].as_str().unwrap();
    let run =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn_id = run.data()["run"]["turn_id"].as_str().unwrap();
    s.gw.wait_terminal("general", turn_id, Duration::from_secs(20))
        .await?;
    let trace = s.gw.get(&format!("/logs/trace?turn_id={turn_id}")).await?;
    assert_eq!(trace.status, 200, "{}", trace.text);
    let spans = trace.data()["spans"].as_array().unwrap();
    let root = spans.iter().find(|s| s["name"] == "schedule.run").unwrap();
    assert!(root["parent_span_id"].is_null());
    assert_eq!(root["status"], "ok");
    assert_eq!(root["tone"], "agent");
    s.finish().await
}

#[tokio::test]
async fn mcp_tool_spans() -> Result<(), HarnessError> {
    use butler_e2e::e2e::scenario::Setup;
    butler_e2e::gate!();
    let server = FakeServer::mcp_http_named("e2e_echo").await?;
    let s = Setup::new("TRACE-04")?
        .cassette("MCP-01")
        .placeholder("NONCE", "trace-response")
        .start()
        .await?;
    super::outbound_http::logging(&s, "detailed").await?;
    let added = s.gw.post("/mcp-servers", json!({"id":"e2e","display_name":"Trace MCP", "enabled":true,"transport":"http","url":format!("{}/mcp", server.base_url)})).await?;
    assert_eq!(added.status, 201, "{}", added.text);
    assert!(super::mcp::healthy(&super::mcp::probe(&s).await?));
    let (turn_id, turn) = s.turn("general", super::mcp::PROMPT).await?;
    assert_eq!(turn["state"], "delivered");
    let trace = s.gw.get(&format!("/logs/trace?turn_id={turn_id}")).await?;
    assert_eq!(trace.status, 200, "{}", trace.text);
    let spans = trace.data()["spans"].as_array().unwrap();
    let mcp = spans
        .iter()
        .find(|s| s["name"] == "mcp.call" && s["attrs"]["method"] == "tools/call")
        .expect("MCP call span");
    assert_eq!(mcp["tone"], "tool");
    assert!(
        spans
            .iter()
            .any(|s| s["name"] == "tool.call" && s["span_id"] == mcp["parent_span_id"])
    );
    assert!(
        spans
            .iter()
            .any(|s| s["name"] == "http.request" && s["parent_span_id"] == mcp["span_id"])
    );
    s.finish().await
}

#[tokio::test]
async fn traceparent_joins_trace_at_standard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = super::setup_local_models::with_local_server("TRACE-05", &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let id = "fedcba9876543210fedcba9876543210";
    let response =
        s.gw.http()
            .post(format!("{}/messages", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("traceparent", format!("00-{id}-0123456789abcdef-01"))
            .json(&json!({"chat_id":"general","text":"Hello"}))
            .send()
            .await?;
    assert_eq!(response.status(), 202);
    let accepted: Value = response.json().await?;
    let turn_id = accepted_turn_id(&accepted["data"])?;
    s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
        .await?;
    let trace = s.gw.get(&format!("/logs/trace?turn_id={turn_id}")).await?;
    assert_eq!(trace.status, 200, "{}", trace.text);
    assert_eq!(trace.data()["trace_id"], id);
    let spans = trace.data()["spans"].as_array().unwrap();
    for name in ["http.server", "turn.admit", "turn.queue", "turn.run"] {
        assert!(
            spans.iter().any(|span| span["name"] == name),
            "missing {name}: {}",
            trace.text
        );
    }
    let server_span = spans
        .iter()
        .find(|span| span["name"] == "http.server")
        .unwrap();
    assert_eq!(server_span["tone"], "app");
    let admit = spans
        .iter()
        .find(|span| span["name"] == "turn.admit")
        .unwrap();
    assert_eq!(admit["parent_span_id"], server_span["span_id"]);
    assert!(
        spans
            .iter()
            .any(|span| span["name"] == "turn.queue" && span["parent_span_id"] == admit["span_id"])
    );
    let mut ancestor = spans
        .iter()
        .find(|span| span["name"] == "turn.run")
        .unwrap();
    let mut chain = Vec::new();
    for _ in 0..spans.len() {
        chain.push(ancestor["name"].as_str().unwrap());
        let Some(parent) = spans
            .iter()
            .find(|span| span["span_id"] == ancestor["parent_span_id"])
        else {
            break;
        };
        ancestor = parent;
    }
    for name in ["http.server", "turn.admit", "turn.queue"] {
        assert!(chain.contains(&name), "missing ancestor {name}: {chain:?}");
    }
    let access = spans
        .iter()
        .find(|span| span["category"] == "http.server" && span["name"] == "http.request")
        .unwrap();
    assert_eq!(access["tone"], "app");
    assert!(
        server
            .seen()
            .iter()
            .all(|r| !r.headers.contains_key("traceparent"))
    );
    s.finish().await
}
