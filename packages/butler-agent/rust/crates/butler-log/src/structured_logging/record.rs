use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Record {
    pub ts: String,
    pub level: String,
    pub process: String,
    pub category: String,
    pub event: String,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parent_span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_ms: Option<f64>,
    #[serde(default = "empty_attrs")]
    pub attrs: Value,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content_len: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub body_ref: Option<String>,
}
fn empty_attrs() -> Value {
    json!({})
}
impl Record {
    pub fn new(level: &str, category: &str, event: &str, msg: &str) -> Self {
        Self {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            level: level.into(),
            process: "agent".into(),
            category: category.into(),
            event: event.into(),
            msg: msg.into(),
            attrs: empty_attrs(),
            trace_id: None,
            span_id: None,
            parent_span_id: None,
            chat_id: None,
            turn_id: None,
            duration_ms: None,
            error: None,
            content: None,
            content_len: None,
            content_hash: None,
            body_ref: None,
        }
    }
}
pub(crate) fn severity(level: &str) -> u8 {
    match level.to_ascii_uppercase().as_str() {
        "ERROR" => 1,
        "WARN" => 2,
        "INFO" => 3,
        "DEBUG" => 4,
        "TRACE" => 5,
        _ => 0,
    }
}
