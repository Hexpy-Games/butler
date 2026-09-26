//! File-backed agent automation tools and their bounded scheduler owner.

mod actor;
mod records;
mod store;
#[cfg(test)]
mod tests;

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration};

use serde_json::{Map, Value};

pub(crate) use actor::NativeAutomationService;

/// One-shot DATA store access for the native CLI. It deliberately does not
/// construct the actor or its scheduler.
pub(crate) struct NativeAutomationCliStore {
    store: store::AutomationStore,
}

impl NativeAutomationCliStore {
    pub(crate) fn new(data_root: PathBuf) -> Self {
        Self {
            store: store::AutomationStore::new(data_root),
        }
    }

    pub(crate) fn list(
        &self,
        include_deleted: bool,
        status: Option<&str>,
    ) -> Result<Vec<Value>, AutomationError> {
        Ok(self
            .store
            .list(include_deleted)?
            .into_iter()
            .filter(|item| status.is_none_or(|status| item.status == status))
            .map(preview_value)
            .collect::<Result<_, _>>()?)
    }

    pub(crate) fn show(&self, id: &str) -> Result<Option<Value>, AutomationError> {
        Ok(self
            .store
            .read(id)?
            .filter(|item| item.status != "deleted")
            .map(preview_value)
            .transpose()?)
    }

    pub(crate) fn run_now(&self, id: &str, now_ms: i64) -> Result<Value, AutomationError> {
        let run = self
            .store
            .run_now(id, now_ms, &crate::js_date::parse_iso_millis)?;
        Ok(serde_json::json!({
            "automation": run.automation,
            "envelope": {
                "eventId": run.envelope.get("eventId"),
                "transport": run.envelope.get("transport"),
                "accountId": run.envelope.get("accountId"),
                "peer": run.envelope.get("peer"),
                "routingHints": run.envelope.get("routingHints"),
                "messageTextIncluded": false,
            }
        }))
    }

    pub(crate) fn delete(&self, id: &str, now_ms: i64) -> Result<Value, AutomationError> {
        self.store.delete(id, now_ms).and_then(preview_value)
    }
}

pub(crate) type AutomationFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, AutomationError>> + Send + 'a>>;

pub(crate) trait AutomationEnqueue: Send + Sync + 'static {
    fn enqueue(&self, envelope: Value, metadata: Map<String, Value>)
    -> Result<(), AutomationError>;
}

fn preview_value(item: impl serde::Serialize) -> Result<Value, AutomationError> {
    serde_json::to_value(item)
        .map_err(|error| AutomationError::new("automation_preview_invalid", error.to_string()))
}

#[derive(Clone, Debug)]
pub(crate) struct AutomationError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl AutomationError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AutomationError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(output, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AutomationError {}

pub(crate) type AutomationDateParser = dyn Fn(&str) -> Option<i64> + Send + Sync;
pub(crate) type AutomationClock = dyn Fn() -> i64 + Send + Sync;

pub(crate) struct AutomationDependencies {
    pub(crate) parse_date: Arc<AutomationDateParser>,
    pub(crate) now_millis: Arc<AutomationClock>,
    pub(crate) enqueue: Arc<dyn AutomationEnqueue>,
    pub(crate) scheduler_interval: Duration,
}
