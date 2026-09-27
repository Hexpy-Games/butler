//! `ledger.jsonl` lines: one `project-ledger.event.v1` record per change,
//! written as JS-compatible JSON in a fixed field order.

use serde::Serialize;
use serde_json::Value;

/// One event line: the schema and time, the event's own fields, and the
/// writer that produced it.
#[derive(Serialize)]
struct LedgerEvent<'a> {
    schema: &'static str,
    ts: &'a str,
    #[serde(flatten)]
    event: Event<'a>,
    source: &'static str,
}

/// What an event records. `kind` is the record kind, `path` the record's
/// display path (null when it has none).
#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum Event<'a> {
    /// A record was created (`<kind>_created`, `attempt_started`).
    Created {
        r#type: &'a str,
        id: &'a str,
        kind: &'a str,
        status: &'a Value,
        path: &'a Value,
    },
    /// A record was updated through the generic update (`<kind>_updated`).
    Updated {
        r#type: &'a str,
        id: &'a str,
        kind: &'a str,
        path: &'a Value,
    },
    /// Work was completed with its report (null when it has none).
    Completed {
        r#type: &'a str,
        id: &'a str,
        report: &'a Value,
    },
    /// A Work, Task or Attempt changed status (`work_updated`, ...).
    Changed { r#type: &'a str, id: &'a str },
    /// The Ledger was initialized.
    #[serde(rename_all = "camelCase")]
    ProjectInitialized {
        r#type: &'a str,
        project_id: &'a str,
    },
    /// The compact index was written with this many records and issues.
    IndexWritten {
        r#type: &'a str,
        records: Option<&'a Value>,
        issues: Option<usize>,
    },
    /// A view was rendered to `path`.
    ViewRendered {
        r#type: &'a str,
        view: &'a str,
        path: &'a str,
    },
}

/// The event's line at `ts`, without the trailing newline.
pub(super) fn line(ts: &str, event: Event<'_>) -> Result<String, EventError> {
    let value = serde_json::to_value(LedgerEvent {
        schema: "project-ledger.event.v1",
        ts,
        event,
        source: "project-ledger",
    })
    .map_err(|source| EventError(Box::new(source)))?;
    butler_core::json::stringify(&value).map_err(|source| EventError(Box::new(source)))
}

/// An event that could not be encoded.
#[derive(Debug, thiserror::Error)]
#[error("ledger event could not be encoded")]
pub(super) struct EventError(#[source] Box<dyn std::error::Error + Send + Sync>);
