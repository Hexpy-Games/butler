//! Passive, privacy-safe operational metrics for conversation admission.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::metric_files::{MetricFile, MetricFiles};

#[derive(Clone)]
pub(crate) struct ConversationMetrics {
    files: Arc<MetricFiles>,
}

impl ConversationMetrics {
    pub(crate) fn new(files: Arc<MetricFiles>) -> Self {
        Self { files }
    }

    pub(crate) fn admission(&self, input: AdmissionMeasure<'_>) {
        let mut event = json!({
            "schema": "butler.operational-metric.v1",
            "ts": now_millis(), "category": "runtime", "name": "conversation_admission",
            "status": if input.admitted { "ok" } else { "skipped" },
            "value": 1, "unit": "event", "rawTextStored": false,
            "dimensions": {
                "admitted": input.admitted,
                "admission_class": input.class_name,
                "event_kind": input.event_kind,
                "reason": input.reason,
                "source": input.source,
                "session_role": input.session_role,
                "session_id_present": !input.session_id.is_empty(),
                "orphan_tool_result_rejected": input.reason == "orphan_tool_result_rejected",
            },
        });
        let dimensions = crate::json::object_mut(&mut event["dimensions"]);
        for (key, value) in [
            ("event_kind", input.event_kind),
            ("session_role", input.session_role),
        ] {
            match safe_dimension(value) {
                Some(value) => {
                    dimensions.insert(key.into(), Value::String(value));
                }
                None => {
                    dimensions.remove(key);
                }
            }
        }
        self.record(&event);
    }

    pub(crate) fn completion(&self, project_scoped: bool, succeeded: bool) {
        self.record(&json!({
            "schema": "butler.operational-metric.v1",
            "ts": now_millis(), "category": "memory", "name": "completion_observation_publish",
            "status": if succeeded { "ok" } else { "error" },
            "rawTextStored": false,
            "dimensions": { "scope": if project_scoped { "project" } else { "global" } },
        }));
    }

    fn record(&self, event: &Value) {
        if !self.enabled() {
            return;
        }
        let mut line = event.to_string().into_bytes();
        line.push(b'\n');
        let _ = self.files.append(MetricFile::OperationalEvents, &line);
        // Source metrics never block live work on a metrics write failure.
    }

    pub(crate) fn enabled(&self) -> bool {
        match std::env::var("BUTLER_METRICS_ENABLED")
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
        {
            Some(value) if ["0", "false", "off", "no"].contains(&value.as_str()) => return false,
            Some(value) if ["1", "true", "on", "yes"].contains(&value.as_str()) => return true,
            _ => {}
        }
        let config = std::fs::read_to_string(self.files.data_root().join("butler.config.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        config
            .as_ref()
            .is_none_or(|value| value["metrics"]["enabled"] != false)
    }
}

pub(crate) fn enabled_for_data_root(data_root: &std::path::Path) -> bool {
    ConversationMetrics::new(Arc::new(MetricFiles::new(data_root.to_path_buf()))).enabled()
}

#[derive(Clone, Copy)]
pub(crate) struct AdmissionMeasure<'a> {
    pub session_id: &'a str,
    pub session_role: &'a str,
    pub source: &'a str,
    pub event_kind: &'a str,
    pub admitted: bool,
    pub class_name: &'a str,
    pub reason: &'a str,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis())
}

fn safe_dimension(value: &str) -> Option<String> {
    let trimmed = crate::public_text::trim_js_whitespace(value);
    let scheme = trimmed.find("://").is_some_and(|at| {
        at > 0
            && trimmed[..at]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"+.-".contains(&byte))
            && trimmed.as_bytes()[0].is_ascii_alphabetic()
    });
    if scheme {
        return None;
    }
    if trimmed.encode_utf16().count() <= 160 {
        return Some(trimmed.into());
    }
    let mut text = crate::json::Utf16Slice::new(trimmed, 0, 160)
        .utf8_lossy()
        .into_owned();
    text.push('…');
    Some(text)
}
