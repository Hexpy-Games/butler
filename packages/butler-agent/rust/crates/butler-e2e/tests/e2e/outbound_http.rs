//! LOG-HTTP-01/06: a real turn reaches its provider through the HTTP boundary.
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
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn log_http_provider_turn_has_context_and_no_external_traceparent() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = super::setup_local_models::with_local_server("LOG-HTTP-01", &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let configured =
        s.gw.send(
            reqwest::Method::PUT,
            "/logs/config",
            Some(json!({"level":"detailed","category_levels":{}}).to_string()),
        )
        .await?;
    assert_eq!(configured.status, 200);
    let accepted = s.gw.say("general", "Hello").await?;
    let turn_id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
            .await?;
    assert_eq!(butler_e2e::e2e::gateway::turn_state(&turn), "delivered");
    let logs =
        s.gw.get(&format!("/logs?turn_id={turn_id}&limit=1000"))
            .await?;
    let rows = logs.data()["rows"].as_array().unwrap();
    let row = rows
        .iter()
        .find(|r| {
            r["event"] == "http.request"
                && r["attrs"]["path"]
                    .as_str()
                    .is_some_and(|p| p.ends_with("/chat/completions"))
        })
        .expect("provider request log");
    assert_eq!(row["attrs"]["method"], "POST");
    assert_eq!(row["attrs"]["host"], "127.0.0.1");
    assert_eq!(row["attrs"]["status"], 200);
    assert_eq!(row["turn_id"], turn_id);
    assert_eq!(row["chat_id"], "general");
    assert!(row["trace_id"].as_str().is_some_and(|s| !s.is_empty()));
    for key in [
        "first_byte_ms",
        "total_ms",
        "request_bytes",
        "response_bytes",
        "chunks",
    ] {
        assert!(row["attrs"][key].is_number(), "{key}: {row}");
    }
    assert!(!logs.text.contains("e2e-custom-private-placeholder"));
    assert!(
        server
            .seen()
            .iter()
            .all(|r| !r.headers.contains_key("traceparent"))
    );
    s.finish().await
}

pub(super) async fn logging(
    s: &butler_e2e::e2e::scenario::Scenario,
    level: &str,
) -> Result<(), HarnessError> {
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let reply =
        s.gw.send(
            reqwest::Method::PUT,
            "/logs/config",
            Some(json!({"level":level,"category_levels":{}}).to_string()),
        )
        .await?;
    assert_eq!(reply.status, 200);
    Ok(())
}

#[tokio::test]
async fn log_http_background_title_and_memory_have_purposes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, prompt) = super::session_titles::start("LOG-HTTP-02").await?;
    logging(&s, "detailed").await?;
    let chat =
        super::session_titles::chat(&s, &super::session_titles::provisional(&prompt), &prompt)
            .await?;
    let (_, turn) = s.turn(&chat, &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let reply = s.gw.get("/logs?category=provider&limit=1000").await?;
            let rows = reply.data()["rows"].as_array().unwrap();
            if ["title", "memory_extraction"].iter().all(|purpose| {
                rows.iter()
                    .any(|r| r["event"] == "http.request" && r["attrs"]["purpose"] == *purpose)
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("background HTTP logs missing")?;
    s.finish().await
}

#[tokio::test]
async fn log_http_full_body_is_retrievable_through_gateway() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = super::setup_local_models::with_local_server("LOG-HTTP-04", &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    logging(&s, "full").await?;
    let accepted =
        s.gw.say("general", &"Complete log payload. ".repeat(700))
            .await?;
    let turn_id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
            .await?;
    assert_eq!(butler_e2e::e2e::gateway::turn_state(&turn), "delivered");
    let reply =
        s.gw.get(&format!("/logs?category=provider&turn_id={turn_id}"))
            .await?;
    let row = reply.data()["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["event"] == "http.request")
        .unwrap();
    assert!(
        reply.data()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| { r["event"] == "http.stream.event" && r["attrs"]["type"] == "message" })
    );
    let reference = row["body_ref"].as_str().expect("large full body reference");
    let body = s.gw.get(&format!("/logs/bodies/{reference}")).await?;
    assert_eq!(body.status, 200);
    assert!(
        server
            .chat_requests()
            .iter()
            .any(|expected| body.body["request"] == butler_log::redact_json(expected))
    );
    let response = body.body["response"].as_str().unwrap();
    assert_eq!(
        response.len() as u64,
        row["attrs"]["response_bytes"].as_u64().unwrap()
    );
    assert!(response.contains("[DONE]"));
    assert_eq!(row["attrs"]["response_complete"], true);
    assert!(!body.text.contains("e2e-custom-private-placeholder"));
    s.finish().await
}

mod bypasses;
mod cli;

/// Match recorded completions to an independent fixture's wire-call counter.
pub(super) async fn http_calls(
    s: &butler_e2e::e2e::scenario::Scenario,
    endpoint: &str,
) -> Result<Vec<serde_json::Value>, HarnessError> {
    let endpoint = url::Url::parse(endpoint).unwrap();
    let reply = s.gw.get("/logs?category=http.client&limit=1000").await?;
    Ok(reply.data()["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| {
            row["event"] == "http.request"
                && row["attrs"]["port"].as_u64() == endpoint.port_or_known_default().map(u64::from)
                && (endpoint.path() == "/"
                    || row["attrs"]["path"]
                        .as_str()
                        .and_then(|p| p.split('?').next())
                        == Some(endpoint.path()))
        })
        .cloned()
        .collect())
}
