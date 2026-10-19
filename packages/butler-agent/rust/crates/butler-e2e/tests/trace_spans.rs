//! TRACE storage contract through the installed production subscriber and writer.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_log::{Config, Logger};
use tracing::Instrument;

#[tokio::test]
async fn trace_spans_preserve_tasks_errors_and_offsets() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = std::env::temp_dir().join(format!("trace-{}", uuid::Uuid::new_v4()));
    let log = Logger::open(&root, Config::detailed())?;
    butler_log::install(log.clone())?;
    log.configure(Config::full())?;
    let trace_id = "0123456789abcdef0123456789abcdef";
    let root_span = tracing::info_span!(target: "butler_e2e", "turn.admit", parent_span_id = "fedcba9876543210", trace_id, chat_id = "chat", turn_id = "turn", message_id = "message");
    async {
        let queue = butler_gateway::gateway::InboundQueue::new(&root);
        let envelope = butler_core::json::JsonDocument::from_value(&serde_json::json!({
            "eventId": "resume", "message": {"text": "continue"}
        }))
        .unwrap();
        let queued = queue.enqueue_reconstructible_async(envelope).await.unwrap();
        assert_eq!(queued.metadata["traceContext"]["trace_id"], trace_id);
        assert_eq!(queued.metadata["traceContext"]["message_id"], "message");
        assert_eq!(
            queued.metadata["traceContext"]["span_id"],
            butler_log::TraceContext::current().span_id.unwrap()
        );
        tokio::spawn(
            async {
                async {
                    tracing::error!(target: "butler_e2e", category = "turn", "nonfatal diagnostic");
                    async {}.instrument(tracing::info_span!(target: "butler_e2e", "tool.call")).await;
                    async {
                        tracing::error!(target: "butler_e2e", category = "model", "request failed");
                    }
                    .instrument(tracing::debug_span!(target: "butler_e2e",
                        "model.request",
                        attempt = 1,
                        attempts = 3
                    ))
                    .await;
                    tokio::time::sleep(std::time::Duration::from_millis(1))
                        .instrument(tracing::warn_span!(target: "butler_e2e", "retry.wait"))
                        .await;
                    async { tracing::trace!(target: "butler_e2e", category = "model", event = "model.payload", content_json = r#"{"password":"private-tool-value"}"#); }
                        .instrument(tracing::debug_span!(target: "butler_e2e",
                            "model.request",
                            attempt = 2,
                            attempts = 3
                        ))
                        .await;
                }
                .instrument(
                    tracing::info_span!(target: "butler_e2e", "turn.run", trace_root = true, model = "provider/model"),
                )
                .await;
            }
            .instrument(tracing::Span::current()),
        )
        .await
        .unwrap();
    }
    .instrument(root_span)
    .await;
    let trace = log.trace(trace_id)?;
    let value = serde_json::to_value(&trace)?;
    let spans = value["spans"].as_array().unwrap();
    assert_eq!(spans.len(), 6);
    assert_eq!(value["model"], "provider/model");
    assert_eq!(value["truncated"], false);
    for (i, span) in spans.iter().enumerate() {
        assert!(span["duration_ms"].as_f64().unwrap() >= 0.0);
        assert!(span["start_offset_ms"].as_f64().unwrap() >= 0.0);
        if let Some(parent) = span["parent_span_id"].as_str() {
            if i == 0 {
                assert_eq!(parent, "fedcba9876543210");
            } else {
                assert!(spans[..i].iter().any(|s| s["span_id"] == parent));
            }
        }
    }
    assert_eq!(spans[0]["parent_span_id"], "fedcba9876543210");
    assert!(spans[1]["parent_span_id"].is_null());
    assert_eq!(spans[1]["attrs"]["follows_from"], spans[0]["span_id"]);
    assert_eq!(spans[1]["status"], "error");
    assert_eq!(spans[2]["name"], "tool.call");
    assert_eq!(spans[2]["status"], "ok");
    assert_eq!(spans[2]["has_details"], false);
    for key in ["status", "failure", "model", "log_level"] {
        assert!(spans[2]["attrs"][key].is_null(), "{key}: {}", spans[2]);
    }
    assert_eq!(spans[2]["attrs"]["message_id"], "message");
    assert_eq!(spans[3]["status"], "error");
    assert_eq!(spans[3]["tone"], "error");
    assert_eq!(spans[4]["tone"], "wait");
    assert_eq!(spans[5]["status"], "ok");
    assert_eq!(spans[5]["has_details"], true);
    let rows = log.query(&butler_log::Query {
        trace_id: Some(trace_id.into()),
        ..Default::default()
    })?;
    let diagnostic = rows
        .rows
        .iter()
        .find(|row| row.msg == "nonfatal diagnostic")
        .unwrap();
    assert!(diagnostic.parent_span_id.is_none());
    let payload = rows
        .rows
        .iter()
        .find(|row| row.event == "model.payload")
        .unwrap();
    assert_eq!(payload.content.as_ref().unwrap()["password"], "[REDACTED]");
    log.shutdown()?;
    std::fs::remove_dir_all(root)?;
    Ok(())
}
