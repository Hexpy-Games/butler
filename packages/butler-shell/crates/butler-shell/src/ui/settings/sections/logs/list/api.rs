//! The log list's data (`logsApi.ts`): the record, a page, the config and the queries that fetch
//! them.
use std::collections::BTreeMap;

use butler_shell_client::{Error, ShellClient};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// `LOG_PRESETS`
pub(super) const PRESETS: [&str; 4] = ["minimal", "standard", "detailed", "full"];
/// `LOG_SEVERITIES`
pub(super) const SEVERITIES: [&str; 5] = ["error", "warn", "info", "debug", "trace"];
/// `LOG_PERIODS` with the hours each covers (`PERIOD_HOURS`); all time has none.
pub(super) const PERIODS: [(&str, Option<i64>); 4] = [
    ("hour", Some(1)),
    ("day", Some(24)),
    ("week", Some(24 * 7)),
    ("all", None),
];
/// `LOG_PAGE_SIZE`
const PAGE_SIZE: u32 = 50;

/// One structured log record as GET /logs and GET /logs/live return it; fields this app does not
/// read stay in `extra`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct LogRecord {
    #[serde(default)]
    pub(super) ts: String,
    #[serde(default)]
    pub(super) level: String,
    #[serde(default)]
    pub(super) process: String,
    #[serde(default)]
    pub(super) category: String,
    #[serde(default)]
    pub(super) event: String,
    #[serde(default)]
    pub(super) msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) parent_span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) attrs: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) body_ref: Option<String>,
    #[serde(flatten)]
    pub(super) extra: Map<String, Value>,
}

/// `LogPage`
#[derive(Debug, Deserialize)]
pub(super) struct LogPage {
    #[serde(default)]
    pub(super) rows: Vec<LogRecord>,
    #[serde(default)]
    pub(super) cursor: Option<String>,
    #[serde(default)]
    pub(super) exhausted: bool,
}

/// `LogConfigView`
#[derive(Debug, Deserialize)]
pub(super) struct LogConfig {
    pub(super) effective: Effective,
    #[serde(default)]
    pub(super) full_expires_at: Option<String>,
    #[serde(default)]
    pub(super) freed_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub(super) struct Effective {
    pub(super) level: String,
    #[serde(default)]
    pub(super) category_levels: BTreeMap<String, String>,
}

/// `LogFilter`: what the list asks for. `source` is "all" or a process; `period` names one of
/// [`PERIODS`].
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Filter {
    pub(super) q: String,
    pub(super) level: String,
    pub(super) source: String,
    pub(super) category: String,
    pub(super) period: &'static str,
}

impl Default for Filter {
    /// `EMPTY_LOG_FILTER`
    fn default() -> Self {
        Self {
            q: String::new(),
            level: String::new(),
            source: "all".into(),
            category: String::new(),
            period: "day",
        }
    }
}

/// `LogWindow`: one page of a query. The agent's cursor binds every filter value, so a query's
/// `since` and `until` are fixed once and reused for each later page.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Range {
    pub(super) since: Option<String>,
    pub(super) until: Option<String>,
    pub(super) cursor: Option<String>,
}

/// `periodSince`: the RFC 3339 start of a period, or none for all time.
pub(super) fn period_since(period: &str) -> Option<String> {
    let hours = PERIODS
        .iter()
        .find(|(name, _)| *name == period)
        .and_then(|(_, hours)| *hours)?;
    let start = chrono::Utc::now() - chrono::Duration::hours(hours);
    Some(start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// `queryLogs`
pub(super) async fn query(
    client: &ShellClient,
    filter: &Filter,
    range: &Range,
) -> Result<Value, Error> {
    let nonempty = |text: &str| (!text.is_empty()).then_some(text.to_owned());
    let q = nonempty(filter.q.trim());
    let source = if filter.source.is_empty() {
        "all"
    } else {
        &filter.source
    };
    client
        .list_logs(
            Some(source),
            nonempty(&filter.level).as_deref(),
            nonempty(&filter.category).as_deref(),
            q.as_deref(),
            None,
            None,
            None,
            None,
            range.since.as_deref(),
            range.until.as_deref(),
            range.cursor.as_deref(),
            Some(PAGE_SIZE),
        )
        .await
}

/// `writeLogConfig`
pub(super) async fn write_config(
    client: &ShellClient,
    level: &str,
    category_levels: &BTreeMap<String, String>,
) -> Result<Value, Error> {
    client
        .update_logs_config(&json!({ "level": level, "category_levels": category_levels }))
        .await
}

/// `readLogBody`: a redacted body by reference, as text.
pub(super) async fn read_body(client: &ShellClient, reference: &str) -> Result<Value, Error> {
    let download = client.read_log_body(reference).await?;
    Ok(Value::String(
        String::from_utf8_lossy(&download.bytes).into_owned(),
    ))
}
