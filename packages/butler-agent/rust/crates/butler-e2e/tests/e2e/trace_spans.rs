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
    let turn_id = s.gw.accepted_turn(&accepted["data"]).await?;
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
    assert_message_shape(spans);
    for name in [
        "turn.admit",
        "turn.dispatch",
        "turn.enqueue",
        "turn.dequeue",
        "turn.run",
        "context.build",
        "route.select",
        "route.resolve",
        "context.tokenize",
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
        if let Some(parent) = span["parent_span_id"].as_str() {
            if span["name"] == "http.server" {
                assert_eq!(parent, "0123456789abcdef");
            } else {
                assert!(spans[..i].iter().any(|s| s["span_id"] == parent));
            }
        }
    }
    assert!(spans.iter().find(|s| s["name"] == "turn.run").unwrap()["attrs"]["model"].is_string());
    let gateway = spans
        .iter()
        .find(|s| s["category"] == "http.server" && s["attrs"]["route"] == "/messages")
        .unwrap();
    let records =
        s.gw.get(&format!("/logs?category=http.server&trace_id={trace_id}"))
            .await?;
    let rows = records.data()["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "HTTP records per inbound request: {rows:?}");
    assert_eq!(
        rows.iter().filter(|r| r["event"] == "span.start").count(),
        1
    );
    let completion = rows.iter().find(|r| r["event"] == "span.end").unwrap();
    assert_eq!(completion["attrs"]["method"], "POST");
    assert_eq!(completion["attrs"]["route"], "/messages");
    assert_eq!(completion["attrs"]["status"], 202);
    assert_eq!(completion["attrs"]["action"], "message.send");
    assert!(completion["duration_ms"].as_f64().unwrap() >= 0.0);
    eprintln!("TRACE-01 inbound_http_records_per_request={}", rows.len());
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
    assert_turn_children(spans);
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
    let turn_id = s.gw.accepted_turn(&accepted["data"]).await?;
    s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
        .await?;
    let trace = s.gw.get(&format!("/logs/trace?turn_id={turn_id}")).await?;
    assert_eq!(trace.status, 200, "{}", trace.text);
    assert_eq!(trace.data()["trace_id"], id);
    let spans = trace.data()["spans"].as_array().unwrap();
    assert_message_shape(spans);
    assert!(
        server
            .seen()
            .iter()
            .all(|r| !r.headers.contains_key("traceparent"))
    );
    s.finish().await
}

#[tokio::test]
async fn state_changing_request_is_visible_before_completion() -> Result<(), HarnessError> {
    use butler_e2e::e2e::scenario::Setup;
    butler_e2e::gate!();
    let message = format!("client-{}", uuid::Uuid::new_v4());
    let mut s = Setup::new("TRACE-OPEN-REQUEST")?
        .cassette("TURN-01")
        .env("BUTLER_E2E_HOLD_QUEUE_MESSAGE", &message)
        .start()
        .await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let trace_id = "123456789abcdef0123456789abcdef0";
    let request =
        s.gw.http()
            .post(format!("{}/messages", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("traceparent", format!("00-{trace_id}-0123456789abcdef-01"))
            .json(&json!({"chat_id":"general", "text":"Hello", "client_message_id":message}))
            .send();
    let request = tokio::spawn(request);
    let held = s.sandbox.data.join("e2e-queue-admission-held");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !held.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "admission barrier not reached"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!request.is_finished());
    let trace = s.gw.get(&format!("/logs/trace/{trace_id}")).await?;
    assert_eq!(trace.status, 200, "{}", trace.text);
    let spans = trace.data()["spans"].as_array().unwrap();
    let http = spans.iter().find(|s| s["name"] == "http.server").unwrap();
    assert!(http["duration_ms"].is_null(), "request still open: {http}");
    assert_eq!(http["tone"], "app");
    s.agent.terminate().await?;
    assert_eq!(request.await.unwrap()?.status(), 503);
    s.finish().await
}

fn assert_message_shape(spans: &[Value]) {
    let inbound: Vec<_> = spans
        .iter()
        .filter(|s| s["category"] == "http.server")
        .collect();
    assert_eq!(inbound.len(), 1, "one App request: {spans:?}");
    let http = inbound[0];
    assert_eq!(http["name"], "http.server");
    assert_eq!(http["tone"], "app");
    assert_eq!(http["attrs"]["method"], "POST");
    assert_eq!(http["attrs"]["route"], "/messages");
    assert_eq!(http["attrs"]["status"], 202);
    assert_eq!(http["attrs"]["action"], "message.send");
    assert_eq!(http["has_details"], true);
    let mut previous = 0.0;
    for name in [
        "http.server",
        "turn.admit",
        "turn.enqueue",
        "turn.dequeue",
        "turn.claim",
        "turn.dispatch",
        "turn.run",
    ] {
        let matching: Vec<_> = spans.iter().filter(|s| s["name"] == name).collect();
        assert_eq!(matching.len(), 1, "{name}: {spans:?}");
        let step = matching[0];
        assert!(
            !spans.iter().any(|s| s["span_id"] == step["parent_span_id"]),
            "top level {name}: {step}"
        );
        let start = step["start_offset_ms"].as_f64().unwrap();
        assert!(start >= previous, "time order {name}: {spans:?}");
        previous = start;
        assert!(step["duration_ms"].as_f64().unwrap() >= 0.0);
    }
    assert!(!spans.iter().any(|s| s["name"] == "turn.queue"));
    let enqueue: Vec<_> = spans
        .iter()
        .filter(|s| s["name"] == "turn.enqueue")
        .collect();
    assert_eq!(enqueue.len(), 1);
    assert!(enqueue[0]["parent_span_id"].is_null());
    let dequeue = spans.iter().find(|s| s["name"] == "turn.dequeue").unwrap();
    assert_eq!(dequeue["attrs"]["follows_from"], enqueue[0]["span_id"]);
    let dispatch = spans.iter().find(|s| s["name"] == "turn.dispatch").unwrap();
    assert_eq!(dispatch["attrs"]["follows_from"], enqueue[0]["span_id"]);
    assert_turn_children(spans);
    for step in spans {
        eprintln!(
            "TRACE-SHAPE {} parent={} id={} start_ms={} follows_from={}",
            step["name"],
            step["parent_span_id"],
            step["span_id"],
            step["start_offset_ms"],
            step["attrs"]["follows_from"]
        );
    }
}

fn assert_turn_children(spans: &[Value]) {
    let run = spans.iter().find(|s| s["name"] == "turn.run").unwrap();
    for step in spans.iter().filter(|s| {
        matches!(
            s["name"].as_str(),
            Some("model.request" | "tool.call" | "memory.extract")
        )
    }) {
        assert_eq!(
            step["parent_span_id"], run["span_id"],
            "direct turn child: {step}"
        );
    }
}
