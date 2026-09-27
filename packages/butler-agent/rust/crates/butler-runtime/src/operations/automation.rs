//! File-backed agent automation tools and their bounded scheduler owner.

mod actor;
mod error;
mod records;
mod store;
#[cfg(test)]
mod tests;

use std::{future::Future, path::Path, pin::Pin, sync::Arc, time::Duration};

use serde_json::{Map, Value};

pub use actor::AutomationService;
pub use error::{AutomationCode, AutomationError};

/// One-shot DATA store access for the native CLI. It deliberately does not
/// construct the actor or its scheduler.
pub struct AutomationCliStore {
    store: store::AutomationStore,
}

impl AutomationCliStore {
    pub fn new(data_root: &Path) -> Self {
        Self {
            store: store::AutomationStore::new(data_root),
        }
    }

    pub fn list(
        &self,
        include_deleted: bool,
        status: Option<&str>,
    ) -> Result<Vec<Value>, AutomationError> {
        self.store
            .list(include_deleted)?
            .into_iter()
            .filter(|item| status.is_none_or(|status| item.status == status))
            .map(preview_value)
            .collect::<Result<_, _>>()
    }

    pub fn show(&self, id: &str) -> Result<Option<Value>, AutomationError> {
        self.store
            .read(id)?
            .filter(|item| item.status != "deleted")
            .map(preview_value)
            .transpose()
    }

    pub fn run_now(&self, id: &str, now_ms: i64) -> Result<Value, AutomationError> {
        let run = self
            .store
            .run_now(id, now_ms, &butler_core::js_date::parse_iso_millis)?;
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

    pub fn delete(&self, id: &str, now_ms: i64) -> Result<Value, AutomationError> {
        self.store.delete(id, now_ms).and_then(preview_value)
    }
}

pub(crate) type AutomationFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, AutomationError>> + Send + 'a>>;

pub trait AutomationEnqueue: Send + Sync + 'static {
    fn enqueue(&self, envelope: Value, metadata: Map<String, Value>)
    -> Result<(), AutomationError>;
}

fn preview_value(item: impl serde::Serialize) -> Result<Value, AutomationError> {
    serde_json::to_value(item).map_err(|error| {
        AutomationError::new(AutomationCode::AutomationPreviewInvalid, error.to_string())
            .with_source(error)
    })
}

pub(crate) type AutomationDateParser = dyn Fn(&str) -> Option<i64> + Send + Sync;
pub(crate) type AutomationClock = dyn Fn() -> i64 + Send + Sync;

pub struct AutomationDependencies {
    pub parse_date: Arc<AutomationDateParser>,
    pub now_millis: Arc<AutomationClock>,
    pub enqueue: Arc<dyn AutomationEnqueue>,
    pub scheduler_interval: Duration,
}
