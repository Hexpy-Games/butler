//! A completed HTTP request must leave its access record on disk.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn settings_records(data: &Path) -> Result<Vec<Value>, HarnessError> {
    let mut rows = Vec::new();
    for entry in fs::read_dir(data.join("logs/agent/main"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            for line in fs::read_to_string(path)?.lines() {
                let row: Value = serde_json::from_str(line)?;
                if row["event"] == "span.end"
                    && row["attrs"]["method"] == "PATCH"
                    && row["attrs"]["route"] == "/settings"
                {
                    rows.push(row);
                }
            }
        }
    }
    rows.sort_by(|a, b| a["ts"].as_str().cmp(&b["ts"].as_str()));
    Ok(rows)
}

#[tokio::test]
async fn logs_access_records_are_written_before_response_completion() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOG-REQUEST-COMPLETION")?.start().await?;
    let initial = settings_records(&s.sandbox.data)?.len();
    for n in 0..30 {
        let reply =
            s.gw.patch("/settings", json!({"reduce_motion":n % 2 == 0}))
                .await?;
        assert_eq!(reply.status, 200);
        // Read the files directly: querying /logs would itself force a flush.
        let rows = settings_records(&s.sandbox.data)?;
        assert_eq!(
            rows.len(),
            initial + n + 1,
            "response preceded access write"
        );
        assert!(rows.iter().all(|r| r["attrs"]["status"] == 200));
        let settings = s.gw.get("/settings").await?;
        assert_eq!(settings.data()["reduce_motion"], n % 2 == 0);
    }
    s.finish().await
}
