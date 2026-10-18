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
    let root_span = tracing::info_span!(target: "butler_e2e", "turn.admit", trace_id, chat_id = "chat", turn_id = "turn");
    async {
        tokio::spawn(
            async {
                async {
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
                    tracing::info_span!(target: "butler_e2e", "turn.run", model = "provider/model"),
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
    assert_eq!(spans.len(), 5);
    assert_eq!(value["model"], "provider/model");
    assert_eq!(value["truncated"], false);
    for (i, span) in spans.iter().enumerate() {
        assert!(span["duration_ms"].as_f64().unwrap() >= 0.0);
        assert!(span["start_offset_ms"].as_f64().unwrap() >= 0.0);
        if let Some(parent) = span["parent_span_id"].as_str() {
            assert!(spans[..i].iter().any(|s| s["span_id"] == parent));
        }
    }
    assert_eq!(spans[2]["status"], "error");
    assert_eq!(spans[2]["tone"], "error");
    assert_eq!(spans[3]["tone"], "wait");
    assert_eq!(spans[4]["status"], "ok");
    assert_eq!(spans[4]["has_details"], true);
    let rows = log.query(&butler_log::Query {
        trace_id: Some(trace_id.into()),
        ..Default::default()
    })?;
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
