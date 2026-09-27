use serde::Serialize;
use serde_json::Value;

use butler_core::json::JsonDocument;

/// A tool call being started.
#[derive(Clone)]
pub struct ToolJournalStart {
    pub turn_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub raw_arguments: String,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub arguments: Value,
}

/// A tool call's result.
pub struct ToolJournalFinish {
    pub call_id: String,
    pub status: ToolJournalFinishStatus,
    pub result: Option<JsonDocument>,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub changed_files: Option<Vec<Value>>,
    pub error_code: Option<String>,
}

/// How a journaled call finished.
#[derive(Clone, Copy)]
pub enum ToolJournalFinishStatus {
    Completed,
    Cancelled,
}

impl ToolJournalFinishStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A journaled tool call.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolJournalRecord {
    pub call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_ordinal: Option<f64>,
    pub tool_name: String,
    pub raw_arguments: String,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub arguments: Value,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonDocument>,
    /// Runtime-private mutation detail, excluded by the replay projection owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub changed_files: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_round_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_response_sha256: Option<String>,
}

/// One ordered closeout page; raw result bodies are released after projection.
pub struct ToolJournalCloseoutRow {
    pub rowid: i64,
    pub tool_name: String,
    pub status: String,
    pub arguments: JsonDocument,
    pub result: Option<JsonDocument>,
    pub changed_files: Option<JsonDocument>,
}

/// Ordered identity-only replay input. Result bodies stay on the SQLite lane.
pub struct ToolJournalSignature {
    pub call_id: String,
    pub tool_name: String,
    pub raw_arguments: String,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub arguments: Value,
}
