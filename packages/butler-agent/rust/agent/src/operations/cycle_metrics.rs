//! Diagnostic consolidation events share the Operations-owned metric file lane.

use std::sync::Arc;

use serde_json::{Value, json};

use super::metric_files::{MetricFile, MetricFiles};

pub(crate) struct CycleMetrics {
    files: Arc<MetricFiles>,
    enabled: bool,
}

impl CycleMetrics {
    pub(crate) fn new(files: Arc<MetricFiles>) -> Self {
        let environment = std::env::var("BUTLER_METRICS_ENABLED")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase());
        let enabled = match environment.as_deref() {
            Some("0" | "false" | "off" | "no") => false,
            Some("1" | "true" | "on" | "yes") => true,
            _ => {
                std::fs::read(files.data_root().join("butler.config.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .and_then(|config| config.pointer("/metrics/enabled").and_then(Value::as_bool))
                    != Some(false)
            }
        };
        Self { files, enabled }
    }

    pub(crate) fn record(&self, name: &str, status: &str, dimensions: Value) {
        if !self.enabled {
            return;
        }
        let event = json!({
            "schema": "butler.operational-metric.v1",
            "ts": chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).timestamp_millis(),
            "category": "memory",
            "name": name,
            "status": status,
            "dimensions": dimensions,
            "rawTextStored": false,
        });
        if let Ok(mut line) = serde_json::to_vec(&event) {
            line.push(b'\n');
            // Source operational metrics are diagnostic and never block live work.
            let _ = self.files.append(MetricFile::OperationalEvents, &line);
        }
    }
}
